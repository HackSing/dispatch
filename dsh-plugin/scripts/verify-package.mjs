#!/usr/bin/env node
/**
 * Pre-pack sanity: every file the package.json protocol points at must exist
 * in the seeded tree, so a bad pack fails here instead of on the user's dsh
 * boot. Static checks only — loading the runtime is the test suite's job.
 *
 * @module dsh-dispatch/scripts/verify-package
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));

const required = [
  pkg.main,
  pkg.exports['./client'] ?? null,
  pkg.dsh?.bundle?.patch ?? null,
  'vendor/dispatch-core.mjs',
  'vendor/node_modules/better-sqlite3/build/Release/darwin-arm64/better_sqlite3.node',
  'vendor/node_modules/better-sqlite3/build/Release/win32-x64/better_sqlite3.node',
  ...promptFiles(),
]
  .filter(Boolean)
  // package.json 里的入口写作 ./lib/…,pack 清单与 fs 相对路径均不带 ./,统一剥掉
  .map((rel) => rel.replace(/^\.\//, ''));

function promptFiles() {
  const dir = path.join(ROOT, 'vendor', 'prompts');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((f) => `vendor/prompts/${f}`);
}

const missing = required.filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
if (missing.length > 0) {
  console.error(`[verify-package] missing files:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
if (promptFiles().length === 0) {
  console.error('[verify-package] vendor/prompts is empty — seed-vendor must run before pack');
  process.exit(1);
}

// seed-vendor 的锚点补丁把 addon 加载点改为按运行时平台直拼路径,
// bindings 已不再引用;两处静态断言防止补丁随上游升级悄悄失效。
const databaseJs = fs.readFileSync(
  path.join(ROOT, 'vendor', 'node_modules', 'better-sqlite3', 'lib', 'database.js'),
  'utf-8',
);
if (!databaseJs.includes(`process.platform + '-' + process.arch`)) {
  console.error('[verify-package] vendor database.js missing the platform-arch addon path — seed-vendor patch did not apply');
  process.exit(1);
}
if (databaseJs.includes(`require('bindings')`)) {
  console.error('[verify-package] vendor database.js still requires bindings — bindings is no longer shipped');
  process.exit(1);
}

// 磁盘存在 ≠ 会被打进 tgz:package.json files 的排除项才是分发边界(vendor/prompts/*.md
// 曾被 !vendor/**/*.md 误杀而磁盘检查全绿)。dry-run 清单是打包器自己的判定,直接对表。
// --ignore-scripts 防止 prepack 再次触发本脚本造成递归。
// win32 的 npm 是 .cmd shim,Node(CVE-2024-27980 修复后)不带 shell 无法直接执行 → 经 shell 调用;
// 参数均为固定字面量,无注入面
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packReport = JSON.parse(
  execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: ROOT,
    encoding: 'utf-8',
    shell: process.platform === 'win32'
  })
);
const packed = new Set(packReport[0].files.map((f) => f.path));
const excluded = required.filter((rel) => !packed.has(rel));
if (excluded.length > 0) {
  console.error(
    `[verify-package] files present on disk but excluded from the pack (check package.json files globs):\n  ${excluded.join('\n  ')}`
  );
  process.exit(1);
}
console.log(
  `[verify-package] ok (${required.length} files, ${promptFiles().length} prompt templates, ${packed.size} packed)`
);
