# c1 验收证据:状态机契约

验收时间:2026-08-28(批次 1 审查)

## 改动

- `src/shared/state-machine.ts`:`TASK_STATUSES` 增 `awaiting_confirm`(running 之后);`TRANSITIONS` 新增三边 `running→awaiting_confirm`、`awaiting_confirm→scheduled`、`awaiting_confirm→failed`;`SETTLED_STATUSES` 保持 `['done','failed']` 不变。
- 穷举消费面:`src/renderer/src/lib/task-labels.ts` 加「待确认」;`src/shell/notifications.ts` NOTIFY_TITLES 加「方案待确认」+ notificationBody case;`src/renderer/src/styles.css` 加 `.badge.awaiting_confirm`(awaiting_merge 同族);`src/renderer/src/lib/task-filters.ts` 经核实 active = 非终态,天然收录,无需改动。

## 验证命令与结果(审查者独立重跑)

- `npm run typecheck` → exit 0(主 + renderer 两个 tsconfig 均过)
- `node scripts/run-vitest.mjs tests/state-machine.test.ts tests/task-labels.test.ts tests/recovery.test.ts tests/ui-state.test.ts` → exit 0,4 文件 28 测试全 passed;覆盖三条新迁移合法、非法迁移(awaiting_confirm→running、todo→awaiting_confirm)抛 IllegalTransitionError、SETTLED 不含 awaiting_confirm、recovery 对 awaiting_confirm 原样保留。
