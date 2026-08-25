// c4 证据:Windows 实机 B2 全链路——真实小仓库 + 真实 kimi,捕获→立即执行→自动合并→归档
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const home = mkdtempSync(join(tmpdir(), 'dispatch-b2-home-'));
process.env.DISPATCH_HOME = home;

// 真实小仓库
const repo = mkdtempSync(join(tmpdir(), 'dispatch-b2-repo-'));
const g = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' });
g('init', '-b', 'main');
g('config', 'user.email', 'b5@test.local');
g('config', 'user.name', 'b5-test');
g('config', 'core.autocrlf', 'false');
writeFileSync(join(repo, 'README.md'), '# b2 chain test\n');
g('add', '.');
g('commit', '-m', 'init');

const PLUGIN = 'file:///D:/Project/dispatch/dsh-plugin';
const rtMod = await import(`${PLUGIN}/src/host/core-runtime.js`);
const logger = {
  info: (m) => console.log(`[info] ${m}`),
  warn: (m) => console.log(`[warn] ${m}`),
  error: (m) => console.log(`[error] ${m}`),
};
const runtime = rtMod.createDispatchRuntime({
  broadcast: (ch, p) => { if (ch === 'task:changed') console.log(`[event] ${JSON.stringify(p)}`); },
  logger,
  version: 'b2-probe',
});
const { ctx, execution } = runtime;

const project = ctx.projects.create({ name: 'b2probe', path: repo });
const task = ctx.tasks.create({
  text: '在 README.md 末尾追加一行文本 hello-from-b5,不要做任何其他修改。',
  projectId: project.id,
  agent: 'kimi',
  triggerType: 'immediate',
});
console.log(`[task] created ${task.id}`);
execution.maybeRunImmediate(ctx.tasks.get(task.id));

const deadline = Date.now() + 15 * 60 * 1000;
let last = '';
for (;;) {
  await new Promise((r) => setTimeout(r, 5000));
  const t = ctx.tasks.get(task.id);
  if (t.status !== last) { last = t.status; console.log(`[status] ${t.status}`); }
  if (['done', 'failed', 'conflict', 'awaiting_merge'].includes(t.status)) break;
  if (Date.now() > deadline) { console.log('[FAIL] 超时'); break; }
}
const final = ctx.tasks.get(task.id);
console.log(`[final] status=${final.status}`);
const readme = readFileSync(join(repo, 'README.md'), 'utf-8');
console.log(`[readme-on-main] ${JSON.stringify(readme)}`);
console.log(`[merged] ${readme.includes('hello-from-b5')}`);
if (final.archiveDir && existsSync(final.archiveDir)) {
  console.log(`[archive] ${readdirSync(final.archiveDir).join(', ')}`);
}
console.log(`[git-log] ${g('log', '--oneline', '-3').trim().replace(/\n/g, ' | ')}`);
await runtime.dispose();
console.log('B2_CHAIN_PROBE_END');
