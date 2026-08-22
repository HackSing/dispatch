#!/usr/bin/env node
/**
 * Run the plugin's node:test suite inside the Electron-as-Node runtime — the
 * same ABI the dsh service process uses (vendor better-sqlite3 is Electron
 * ABI, so plain `node --test` cannot load it).
 *
 * @module dsh-dispatch/scripts/run-tests
 */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.join(HERE, '..');
const PARENT_ROOT = path.join(PLUGIN_ROOT, '..');

const require = createRequire(path.join(PARENT_ROOT, 'package.json'));
const electronPath = require('electron');
if (typeof electronPath !== 'string' || !fs.existsSync(electronPath)) {
  console.error('[run-tests] electron binary not found — run npm install in the dispatch repo first.');
  process.exit(1);
}

const tests = fs.readdirSync(path.join(PLUGIN_ROOT, 'tests')).filter((f) => f.endsWith('.test.js'));
const result = spawnSync(electronPath, ['--test', ...tests.map((f) => path.join('tests', f))], {
  cwd: PLUGIN_ROOT,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
