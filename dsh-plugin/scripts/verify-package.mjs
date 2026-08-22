#!/usr/bin/env node
/**
 * Pre-pack sanity: every file the package.json protocol points at must exist
 * in the seeded tree, so a bad pack fails here instead of on the user's dsh
 * boot. Static checks only — loading the runtime is the test suite's job.
 *
 * @module dsh-dispatch/scripts/verify-package
 */
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
  'vendor/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  'vendor/node_modules/bindings/bindings.js',
  ...promptFiles(),
].filter(Boolean);

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
console.log(`[verify-package] ok (${required.length} files, ${promptFiles().length} prompt templates)`);
