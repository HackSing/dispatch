#!/usr/bin/env node
/**
 * Materialize `vendor/` from the parent dispatch repo, right before tests or
 * packaging. vendor/ 的唯一写入者,产物不入库:
 *
 *   vendor/dispatch-core.mjs          — esbuild bundle of ../src/core + ../src/shared
 *   vendor/node_modules/better-sqlite3 & friends — Electron-ABI prebuilt
 *   vendor/prompts/                   — built-in prompt templates
 *
 * better-sqlite3 必须以 Electron ABI 物化(dsh 服务进程 = Electron 38 +
 * ELECTRON_RUN_AS_NODE=1,ABI 139):用户机器经 pnpm 安装时依赖脚本可能被
 * 脚本审批机制跳过、或按系统 Node ABI 重编,两者都无法在 dsh 进程加载,
 * 因此插件包不声明 better-sqlite3 依赖、只携带 vendor 副本(bundle 对其
 * external,运行时从 vendor/node_modules 解析)。
 *
 * @module dsh-dispatch/scripts/seed-vendor
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.join(HERE, '..');
const PARENT_ROOT = path.join(PLUGIN_ROOT, '..');
const VENDOR_ROOT = path.join(PLUGIN_ROOT, 'vendor');

const require = createRequire(path.join(PARENT_ROOT, 'package.json'));

const CORE_ENTRY = path.join(PLUGIN_ROOT, 'src', 'host', 'core-exports.ts');
const NATIVE_PACKAGES = [
  { name: 'better-sqlite3', keep: ['lib', 'build', 'package.json'] },
  { name: 'bindings', keep: ['bindings.js', 'package.json'] },
  { name: 'file-uri-to-path', keep: ['index.js', 'package.json'] },
];

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
  const binary = path.join(vendorModules, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  if (!fs.existsSync(binary)) {
    throw new Error(`[seed-vendor] Electron-ABI binary missing at ${binary} — parent install must run its postinstall (electron-builder install-app-deps).`);
  }
}

function copyPrompts() {
  fs.cpSync(path.join(PARENT_ROOT, 'resources', 'prompts'), path.join(VENDOR_ROOT, 'prompts'), { recursive: true });
}

function main() {
  assertParentRepo();
  fs.rmSync(VENDOR_ROOT, { recursive: true, force: true });
  bundleCore();
  copyNativePackages();
  copyPrompts();
  console.log(`[seed-vendor] materialized ${path.relative(PARENT_ROOT, VENDOR_ROOT)}`);
}

main();
