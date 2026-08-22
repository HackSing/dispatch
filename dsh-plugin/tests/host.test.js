/**
 * Host-half integration tests over the fakes: the plugin's apply() wiring,
 * the invoke bridge against a real (temp-homed) core runtime, and the SSE
 * event stream. Must run via scripts/run-tests.mjs (Electron-as-Node ABI).
 *
 * @module dsh-dispatch/tests/host.test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 隔离先行:homedir() 动态读 HOME,default 项目种子与 dispatchHome 都被圈进临时目录
const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-dispatch-test-'));
process.env.HOME = fakeHome;
process.env.DISPATCH_HOME = join(fakeHome, '.dispatch');

const { apply } = await import('../src/host/index.js');
const { fakeContext } = await import('./fake-context.js');
const { fakeReq, fakeRes, drive } = await import('./fake-http.js');

function mountedPlugin() {
  const fake = fakeContext();
  apply(fake.ctx);
  fake.runInjects();
  return fake;
}

test('apply 注册 /api/dispatch prefix 路由', async () => {
  const fake = mountedPlugin();
  assert.equal(fake.registrations.length, 1);
  assert.equal(fake.registrations[0].path, '/api/dispatch');
  for (const d of fake.runDisposers()) await d?.();
});

test('invoke 全链:建任务→列表→状态', async () => {
  const fake = mountedPlugin();
  const handler = fake.registrations[0].handler;

  const created = await drive(handler, fakeReq({ url: '/api/dispatch/invoke/task:create', body: { text: '插件测试任务', projectId: 'default', agent: null, subAgent: null, triggerType: 'none', triggerAt: null } }), fakeRes());
  assert.equal(created.statusCode, 200);
  const createdBody = created.body();
  assert.equal(createdBody.ok, true);
  assert.ok(createdBody.value.id);

  const listed = await drive(handler, fakeReq({ url: '/api/dispatch/invoke/task:list' }), fakeRes());
  const listBody = listed.body();
  assert.equal(listBody.ok, true);
  assert.ok(listBody.value.some((t) => t.text === '插件测试任务'));

  const status = await drive(handler, fakeReq({ url: '/api/dispatch/invoke/app:status' }), fakeRes());
  const statusBody = status.body();
  assert.equal(statusBody.ok, true);
  assert.equal(statusBody.value.dispatchHome, process.env.DISPATCH_HOME);
  assert.equal(statusBody.value.platform, process.platform);

  // 壳快捷键状态经 env 透出(hotkeyChildEnv 注入);无壳时诚实返回未注册
  const hotkey = await drive(handler, fakeReq({ url: '/api/dispatch/invoke/app:hotkey-status' }), fakeRes());
  assert.equal(hotkey.body().value.registered, false);
  const prevReg = process.env.DSH_BUDDY_HOTKEY_REGISTERED;
  const prevAcc = process.env.DSH_BUDDY_HOTKEY_ACCELERATOR;
  process.env.DSH_BUDDY_HOTKEY_REGISTERED = '1';
  process.env.DSH_BUDDY_HOTKEY_ACCELERATOR = 'Alt+Space';
  const hotkeyOn = await drive(handler, fakeReq({ url: '/api/dispatch/invoke/app:hotkey-status' }), fakeRes());
  assert.deepEqual(hotkeyOn.body().value, { accelerator: 'Alt+Space', registered: true });
  if (prevReg === undefined) delete process.env.DSH_BUDDY_HOTKEY_REGISTERED;
  else process.env.DSH_BUDDY_HOTKEY_REGISTERED = prevReg;
  if (prevAcc === undefined) delete process.env.DSH_BUDDY_HOTKEY_ACCELERATOR;
  else process.env.DSH_BUDDY_HOTKEY_ACCELERATOR = prevAcc;

  // client 侧 encodeURIComponent 编码冒号,host 必须解码后再比对白名单
  const encoded = await drive(handler, fakeReq({ url: `/api/dispatch/invoke/${encodeURIComponent('app:status')}` }), fakeRes());
  assert.equal(encoded.body().ok, true);

  for (const d of fake.runDisposers()) await d?.();
});

test('降级与未知通道:错误码协议', async () => {
  const fake = mountedPlugin();
  const handler = fake.registrations[0].handler;

  const unsupported = await drive(handler, fakeReq({ url: '/api/dispatch/invoke/task:open-archive', body: { id: 'x' } }), fakeRes());
  assert.equal(unsupported.body().error.code, 'not_supported');

  const unknown = await drive(handler, fakeReq({ url: '/api/dispatch/invoke/nope:channel', body: {} }), fakeRes());
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.body().error.code, 'unknown-channel');

  const notFound = await drive(handler, fakeReq({ method: 'GET', url: '/api/dispatch/other' }), fakeRes());
  assert.equal(notFound.statusCode, 404);

  for (const d of fake.runDisposers()) await d?.();
});

test('project:remove:default 拒删,普通项目可删', async () => {
  const fake = mountedPlugin();
  const handler = fake.registrations[0].handler;

  const refuse = await drive(handler, fakeReq({ url: '/api/dispatch/invoke/project:remove', body: { id: 'default' } }), fakeRes());
  assert.equal(refuse.body().ok, false);
  assert.match(refuse.body().error.message, /默认项目不可移除/);

  const created = await drive(handler, fakeReq({ url: '/api/dispatch/invoke/project:create', body: { path: '/tmp/dsh-dispatch-proj-x' } }), fakeRes());
  const pid = created.body().value.id;
  const removed = await drive(handler, fakeReq({ url: '/api/dispatch/invoke/project:remove', body: { id: pid } }), fakeRes());
  assert.equal(removed.body().ok, true);

  for (const d of fake.runDisposers()) await d?.();
});

test('非 loopback 来源被 403 拒绝', async () => {
  const fake = mountedPlugin();
  const denied = await drive(fake.registrations[0].handler, fakeReq({ url: '/api/dispatch/invoke/task:list', remoteAddress: '10.0.0.5' }), fakeRes());
  assert.equal(denied.statusCode, 403);
  for (const d of fake.runDisposers()) await d?.();
});

test('SSE 流:事件以具名 event 帧下发', async () => {
  const fake = mountedPlugin();
  const handler = fake.registrations[0].handler;
  const stream = fakeRes();

  const settled = drive(handler, fakeReq({ method: 'GET', url: '/api/dispatch/events' }), stream, 1500).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 50));

  // 建一个任务触发 task:changed 广播(store onChange → hub.broadcast)
  await drive(handler, fakeReq({ url: '/api/dispatch/invoke/task:create', body: { text: 'SSE 测试', projectId: 'default', agent: null, subAgent: null, triggerType: 'none', triggerAt: null } }), fakeRes());
  await new Promise((r) => setTimeout(r, 50));

  const frames = stream.frames();
  assert.match(frames, /event: task:changed\ndata: .+/);
  assert.match(stream.headers['Content-Type'], /text\/event-stream/);

  stream.end();
  await settled;
  for (const d of fake.runDisposers()) await d?.();
});

test('dispose 幂等:重复收口不抛错', async () => {
  const fake = mountedPlugin();
  const disposers = fake.runDisposers();
  for (const d of disposers) await d?.();
  // 第二次运行同一批 disposer(closed 守卫应吞掉重复)
  for (const d of disposers) await d?.();
});
