# c4 验收证据:IPC 契约与构建

验收时间:2026-08-28(批次 3+4 审查)

## 契约落点

- `src/shared/ipc.ts`:InvokeMap 新增 `task:confirm-plan {id}->Task`、`task:plan-discuss-open {id}->void`、`task:plan-discuss-send {id,text}->void`、`task:plan-discuss-close {id}->void`;INVOKE_CHANNELS 数组同步注册;EventMap 复用 `task:session-event` 未新增;`TaskArchive` 追加 `discussionLog` 字段。
- `src/shell/ipc-handlers.ts` 注册四 handler 瘦委托;preload 白名单自 INVOKE_CHANNELS 派生(ipc-contract 测试守)。
- 渲染层消费链:`PlanConfirmPanel` 调用的 4 频道与事件均在主进程有 handler/广播源,任务状态一律等 task:changed 重拉。

## 验证命令与结果(审查者独立重跑)

- `node scripts/run-vitest.mjs tests/ipc-contract.test.ts`(含于批次 3 统一测试命令)→ passed
- `npm run typecheck` → exit 0(主 + renderer 两个 tsconfig)
- `npm run build`(electron-vite 全量,main/preload/renderer 三产物)→ exit 0,✓ built
