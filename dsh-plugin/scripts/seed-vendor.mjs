#!/usr/bin/env node
/**
 * Materialize `vendor/` from the parent dispatch repo, right before tests or
 * packaging. vendor/ 的唯一写入者,产物不入库:
 *
 *   vendor/dispatch-core.mjs          — esbuild bundle of ../src/core + ../src/shared
 *   vendor/node_modules/better-sqlite3 — lib + 多平台 Electron-ABI prebuilt 二进制
 *   vendor/prompts/                   — built-in prompt templates
 *
 * better-sqlite3 必须以 Electron ABI 物化(dsh 服务进程 = Electron +
 * ELECTRON_RUN_AS_NODE=1):用户机器经 pnpm 安装时依赖脚本可能被脚本审批机制
 * 跳过、或按系统 Node ABI 重编,两者都无法在 dsh 进程加载,因此插件包不声明
 * better-sqlite3 依赖、只携带 vendor 副本(bundle 对其 external,运行时从
 * vendor/node_modules 解析)。
 *
 * 多平台布局:不再从父仓 node_modules 拷贝 build 目录(那里只有构建机单平台
 * 产物),而是按 {version, abi, platformArch} 从上游 WiseLibs/better-sqlite3
 * releases 下载官方 prebuild,落位:
 *
 *   vendor/node_modules/better-sqlite3/build/Release/<platform-arch>/better_sqlite3.node
 *
 * - version 取父仓 node_modules/better-sqlite3/package.json;
 * - abi 用 ELECTRON_RUN_AS_NODE=1 <electron> -p process.versions.modules 运行时
 *   推导(electronPath 取法同 scripts/run-tests.mjs),不许硬编码;
 * - 下载缓存于父仓 node_modules/.cache/bs3-prebuilds/,已存在且非空则跳过,
 *   支持离线复跑;
 * - 落位后做文件魔数断言(darwin=Mach-O,win32=MZ),下载/解包/断言任何一步
 *   失败都硬失败,不产出半成品。
 *
 * 锚点补丁纪律:vendored lib/database.js 里 require('bindings') 的加载行被
 * 精确字符串替换为按 process.platform + '-' + process.arch 直拼的路径,因此
 * bindings/file-uri-to-path 不再需要。锚点未命中(如上游升级改了这行)必须
 * 抛错终止并提示人工重验补丁,不许静默跳过。
 *
 * @module dsh-dispatch/scripts/seed-vendor
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.join(HERE, '..');
const PARENT_ROOT = path.join(PLUGIN_ROOT, '..');
const VENDOR_ROOT = path.join(PLUGIN_ROOT, 'vendor');

const require = createRequire(path.join(PARENT_ROOT, 'package.json'));

const CORE_ENTRY = path.join(PLUGIN_ROOT, 'src', 'host', 'core-exports.ts');
const NATIVE_PACKAGES = [
  // build 目录不随包拷贝——多平台二进制由 seedNativeAddons 自建布局
  { name: 'better-sqlite3', keep: ['lib', 'package.json'] },
];

const PREBUILD_ENTRY = 'build/Release/better_sqlite3.node';
const PREBUILD_TARGETS = [
  { platformArch: 'darwin-arm64', magic: [0xcf, 0xfa, 0xed, 0xfe], magicName: 'Mach-O' },
  { platformArch: 'win32-x64', magic: [0x4d, 0x5a], magicName: 'MZ' },
];
const PREBUILD_CACHE = path.join(PARENT_ROOT, 'node_modules', '.cache', 'bs3-prebuilds');

// 锚点补丁:database.js 第 48 行的 bindings 加载点(见文件头注释)
const PATCH_ANCHOR = `addon = DEFAULT_ADDON || (DEFAULT_ADDON = require('bindings')('better_sqlite3.node'));`;
const PATCH_REPLACEMENT = `addon = DEFAULT_ADDON || (DEFAULT_ADDON = require(path.join(__dirname, '..', 'build', 'Release', process.platform + '-' + process.arch, 'better_sqlite3.node')));`;

function assertParentRepo() {
  const marker = path.join(PARENT_ROOT, 'src', 'core', 'paths.ts');
  if (!fs.existsSync(marker)) {
    throw new Error(
      `[seed-vendor] parent dispatch repo not found (${marker}) — build from inside the dispatch monorepo (dispatch/dsh-plugin).`,
    );
  }
}

async function bundleCore() {
  const esbuild = require('esbuild');
  await esbuild.build({
    entryPoints: [CORE_ENTRY],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['better-sqlite3'],
    alias: {
      '@core': path.join(PARENT_ROOT, 'src', 'core'),
      '@shared': path.join(PARENT_ROOT, 'src', 'shared'),
    },
    outfile: path.join(VENDOR_ROOT, 'dispatch-core.mjs'),
    logLevel: 'warning',
  });
}

function copyNativePackages() {
  const parentModules = path.join(PARENT_ROOT, 'node_modules');
  const vendorModules = path.join(VENDOR_ROOT, 'node_modules');
  for (const { name, keep } of NATIVE_PACKAGES) {
    const src = path.join(parentModules, name);
    const dest = path.join(vendorModules, name);
    if (!fs.existsSync(src)) {
      throw new Error(`[seed-vendor] ${name} missing from parent node_modules — run npm install in the dispatch repo first.`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true, filter: (f) => keep.some((k) => f === src || f.startsWith(path.join(src, k))) });
  }
}

function betterSqlite3Version() {
  const pkgPath = path.join(PARENT_ROOT, 'node_modules', 'better-sqlite3', 'package.json');
  return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
}

function electronAbi() {
  const electronPath = require('electron');
  if (typeof electronPath !== 'string' || !fs.existsSync(electronPath)) {
    throw new Error('[seed-vendor] electron binary not found — run npm install in the dispatch repo first.');
  }
  const out = execFileSync(electronPath, ['-p', 'process.versions.modules'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf-8',
  }).trim();
  if (!/^\d+$/.test(out)) {
    throw new Error(`[seed-vendor] unexpected Electron ABI from process.versions.modules: ${JSON.stringify(out)}`);
  }
  return out;
}

function prebuildUrl(version, abi, platformArch) {
  const file = `better-sqlite3-v${version}-electron-v${abi}-${platformArch}.tar.gz`;
  return {
    file,
    url: `https://github.com/WiseLibs/better-sqlite3/releases/download/v${version}/${file}`,
  };
}

async function fetchPrebuild(version, abi, { platformArch }) {
  const { file, url } = prebuildUrl(version, abi, platformArch);
  fs.mkdirSync(PREBUILD_CACHE, { recursive: true });
  const cached = path.join(PREBUILD_CACHE, file);
  if (fs.existsSync(cached) && fs.statSync(cached).size > 0) {
    return cached;
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`[seed-vendor] prebuild download failed (${res.status}) ${url}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error(`[seed-vendor] prebuild download empty ${url}`);
  }
  fs.writeFileSync(cached, bytes);
  return cached;
}

function extractAndPlace(tarball, { platformArch, magic, magicName }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bs3-prebuild-'));
  try {
    execFileSync('tar', ['-xzf', tarball, '-C', tmp, PREBUILD_ENTRY]);
    const extracted = path.join(tmp, PREBUILD_ENTRY);
    if (!fs.existsSync(extracted)) {
      throw new Error(`[seed-vendor] ${PREBUILD_ENTRY} not found inside ${path.basename(tarball)}`);
    }
    const destDir = path.join(VENDOR_ROOT, 'node_modules', 'better-sqlite3', 'build', 'Release', platformArch);
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, 'better_sqlite3.node');
    fs.copyFileSync(extracted, dest);
    // 魔数断言:落位的二进制必须是目标平台的原生格式,不符即抛错不产出半成品
    const head = new Uint8Array(magic.length);
    const fd = fs.openSync(dest, 'r');
    try {
      fs.readSync(fd, head, 0, head.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (!magic.every((b, i) => head[i] === b)) {
      fs.rmSync(dest, { force: true });
      throw new Error(
        `[seed-vendor] magic mismatch for ${platformArch} (expected ${magicName}, got 0x${Buffer.from(head).toString('hex')}) — refusing to ship a wrong binary.`,
      );
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function seedNativeAddons() {
  const version = betterSqlite3Version();
  const abi = electronAbi();
  for (const target of PREBUILD_TARGETS) {
    const tarball = await fetchPrebuild(version, abi, target);
    extractAndPlace(tarball, target);
  }
}

function patchDatabaseJs() {
  const file = path.join(VENDOR_ROOT, 'node_modules', 'better-sqlite3', 'lib', 'database.js');
  const src = fs.readFileSync(file, 'utf-8');
  if (!src.includes(PATCH_ANCHOR)) {
    throw new Error(
      `[seed-vendor] patch anchor not found in ${file} — better-sqlite3 likely changed its addon load line; manually re-verify the patch before proceeding (do NOT skip silently).\n  expected: ${PATCH_ANCHOR}`,
    );
  }
  fs.writeFileSync(file, src.replace(PATCH_ANCHOR, PATCH_REPLACEMENT));
}

function copyPrompts() {
  fs.cpSync(path.join(PARENT_ROOT, 'resources', 'prompts'), path.join(VENDOR_ROOT, 'prompts'), { recursive: true });
}

async function main() {
  assertParentRepo();
  fs.rmSync(VENDOR_ROOT, { recursive: true, force: true });
  await bundleCore();
  copyNativePackages();
  await seedNativeAddons();
  patchDatabaseJs();
  copyPrompts();
  console.log(`[seed-vendor] materialized ${path.relative(PARENT_ROOT, VENDOR_ROOT)}`);
}

await main();
