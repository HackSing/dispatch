// 五 agent detect 实测(验收 c5 证据):经新构建插件的 runtime 跑 refreshDetections
const PLUGIN = 'file:///D:/Project/dispatch/dsh-plugin';
const rtMod = await import(`${PLUGIN}/src/host/core-runtime.js`);
const logger = { info: () => {}, warn: () => {}, error: (m) => console.error(`[error] ${m}`) };
const runtime = rtMod.createDispatchRuntime({ broadcast: () => {}, logger, version: 'probe' });
const list = await runtime.refreshDetections();
for (const d of list) {
  console.log(JSON.stringify({ agent: d.agent ?? d.id, ok: d.ok, version: d.version ?? null, failReason: d.failReason ?? null }));
}
await runtime.dispose();
