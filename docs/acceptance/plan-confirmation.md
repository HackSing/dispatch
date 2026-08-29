> 状态：已验收-仅追溯
<!-- docs-harness:acceptance-document/v1 -->

# 方案确认闸验收:执行前用户确认与多轮方案讨论

- 修订：8
- 关键符号：`awaiting_confirm`、`PlanDiscussionSession`、`task:confirm-plan`、`runPlanPhase`
- 资产指纹：`sha256:88105eb9e262c636eb12e1fda77f6fecce6dd8ce9ff6e97f924bab7ec679b499`
- 关联方案：`docs/plans/plan-confirmation.json`

## 验收目标

任务状态机新增 awaiting_confirm(待确认)状态:方案阶段判过后任务由 running 迁入并暂停(释放执行信号量、保留 worktree/归档/会话 id),触发系统通知;用户在详情页查看 plan.md、经会话传输与主智能体多轮讨论修订 plan.md;点确认后任务重新入队,执行器跳过方案阶段直接执行;放弃则落 failed(abandoned) 并清理 worktree。单点与工作流两种模式行为一致。

## 验收标准

### `c1` 状态机契约:TASK_STATUSES/TRANSITIONS 新增 awaiting_confirm 三条边(running→awaiting_confirm、awaiting_confirm→scheduled、awaiting_confirm→failed),非法迁移抛错,SETTLED_STATUSES 不变;穷举消费面(任务标签/过滤器/通知标题/徽章)齐备

- 状态：passed
- 类型：contract_check
- 层级：L1
- 证据：`docs/acceptance/evidence/plan-confirmation/c1-state-machine.md`

### `c2` 执行器两跑行为:单点模式首跑写出 plan.md 后停 awaiting_confirm,确认后重入跳过方案阶段执行至 done;工作流模式确认后跳过 runPlanPhase 直入 implement;首跑后 result.json 已存在时走连跑兼容分支不暂停;重入复用 archiveDir/worktreePath/branch 且跳过 prepare_cmd

- 状态：passed
- 类型：behavior_acceptance
- 层级：L2
- 证据：`docs/acceptance/evidence/plan-confirmation/c2-executor-two-run.md`

### `c3` 讨论引擎与恢复:PlanDiscussionSession 守卫(非 awaiting_confirm/无 sessionId/无 resume 能力拒绝)、轮次串行闸门、轮级失败不动任务状态;崩溃恢复对 awaiting_confirm 原样保留;放弃落 failed(abandoned) 并清理 worktree

- 状态：passed
- 类型：behavior_acceptance
- 层级：L2
- 证据：`docs/acceptance/evidence/plan-confirmation/c3-discussion-recovery.md`

### `c4` IPC 契约与构建:task:confirm-plan 与 task:plan-discuss-open/send/close 在 src/shared/ipc.ts 三处(InvokeMap/EventMap/CHANNELS 数组)注册一致,npm run build(typecheck+electron-vite)通过

- 状态：passed
- 类型：contract_check
- 层级：L1
- 证据：`docs/acceptance/evidence/plan-confirmation/c4-ipc-build.md`

### `c5` 真实流程:本地应用用真实 agent CLI 走通「创建任务→方案完成→系统通知→详情页查看方案→讨论一轮修订 plan.md→确认→执行完成 done」全链路

- 状态：passed
- 类型：user_acceptance
- 层级：L5
- 证据：`docs/acceptance/evidence/plan-confirmation/c5-user-acceptance.md`、`docs/acceptance/evidence/plan-confirmation/l3-real-claude.md`
