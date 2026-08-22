#!/usr/bin/env node
/**
 * Pack src/client into lib/client.js in the lazy-CJS shape the dsh module
 * loader expects: `window.__ModuleLoader__.load({id, factory})`. React 19,
 * zustand and the renderer components are bundled self-contained (the host
 * page keeps its own React 18 — pet precedent); styles.css rides along as a
 * text import and is injected inside the panel's shadow root.
 *
 * @module dsh-dispatch/scripts/build-client
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.join(HERE, '..');
const PARENT_ROOT = path.join(PLUGIN_ROOT, '..');

const require = createRequire(path.join(PARENT_ROOT, 'package.json'));
const esbuild = require('esbuild');

// dsh 的 loader factory 只保证传 require;esbuild 的 cjs 产物需要 module/exports
// 在 banner 内自声明(docs-harness build-client 同款形状),footer 返回模块表行。
const banner = 'window.__ModuleLoader__.load({id: \'@aiwaretop/dsh-dispatch/client\', factory: (require) => {\n'
  + 'var module = { exports: {} }; var exports = module.exports;';
const footer = 'return module.exports; } });';

await esbuild.build({
  entryPoints: [path.join(PLUGIN_ROOT, 'src', 'client', 'index.tsx')],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  outfile: path.join(PLUGIN_ROOT, 'lib', 'client.js'),
  loader: { '.css': 'text' },
  jsx: 'automatic',
  alias: { '@shared': path.join(PARENT_ROOT, 'src', 'shared') },
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: { js: banner },
  footer: { js: footer },
  logLevel: 'warning',
});

console.log('[build-client] wrote lib/client.js');
