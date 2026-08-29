# 项目文档索引

项目文档从这里进入；Docs Harness 只维护下方任务方案区块。

<!-- docs-harness:plans-index:start -->
## 任务方案

- [工作流第一阶段:主智能体方案 → 子智能体实现 → 主智能体审查](plans/workflow-stage1.md) — 状态：已实施-仅追溯（代码已是真源，2026-08-22 核对）；关键符号：`sub_agent`、`runWorkflow`、`review_round`、`wf-implement`
- [交互批 V0.2r2:追问改为常驻会话面板(单 worktree 多轮对话,结束一次合并)](plans/interaction-batch-v03.md) — 状态：有效（实施中）；关键符号：`FollowUpSession`、`resume_stream_args`、`task:follow-up-send`、`rounds.jsonl`
- [主窗看板化与 macOS 风格前端重设计](plans/macos-ui-redesign.md) — 状态：已实施-仅追溯（代码已是真源，2026-08-22 核对）；关键符号：`ProjectColumn`、`AgentChainPicker`、`board-col`、`capture-pop`
- [dispatch 插件化为 dsh 双半插件（@aiwaretop/dsh-dispatch）](plans/dispatch-dsh-plugin.md) — 状态：已实施-仅追溯（代码已是真源，2026-08-22 核对）；关键符号：`DispatchApi`、`INVOKE_CHANNELS`、`ipc-bridge`、`event-bridge`
- [dsh 追问面板与沙箱放行:headless-dispatch 专用 profile 与会话续接](plans/dsh-headless-session-panel.md) — 状态：已实施-仅追溯（代码已是真源，2026-08-22 核对）；关键符号：`dsh-headless-session`、`headless-dispatch`、`agents.resume`、`sandbox-policy`
- [工单档位路由:default.md 移植 docs harness 触发条件分档](plans/task-tier-routing.md) — 状态：已实施-仅追溯（代码已是真源，2026-08-23 核对）；关键符号：`simple_direct_answer`、`effect_requires_work`、`prompt-real-template`、`judgeArtifacts`
- [项目看板列拖拽排序(桌面端 + dsh 插件)](plans/project-column-drag-reorder.md) — 状态：已实施-仅追溯（代码已是真源，2026-08-23 核对）；关键符号：`project:reorder`、`ProjectStore.reorder`、`sort_order`、`ProjectColumn`
- [B5 Windows 适配:platform 层 win32 实现与全链路 Windows 可用](plans/b5-windows-adaptation.md) — 状态：已实施-仅追溯（代码已是真源，2026-08-25 核对）；关键符号：`win32Ops`、`PlatformOps`、`spawnShellDetached`、`getPlatformOps`
- [方案确认闸:任务执行前的用户确认与多轮方案讨论](plans/plan-confirmation.md) — 状态：已实施-仅追溯（代码已是真源，2026-08-29 核对）；关键符号：`awaiting_confirm`、`PlanDiscussionSession`、`task:confirm-plan`、`runPlanPhase`
<!-- docs-harness:plans-index:end -->

<!-- docs-harness:knowledge-index:start -->
## 项目知识

- [dsh agent 会话接入:headless-dispatch profile 与 CLI 契约](knowledge/dsh-headless-dispatch-profile.md) — 状态：有效（现行事实）；关键符号：`dsh-headless-session`、`headless-dispatch`、`resume_headless_args`、`dispatchHeadlessStartup`
- [dsh-dispatch 插件的运行时 ABI 与 loader/UI 呈现契约](knowledge/dsh-dispatch-plugin-runtime.md) — 状态：有效（现行事实）；关键符号：`seed-vendor.mjs`、`build-client.mjs`、`mountPanelView`、`mountSidebarEntry`
- [方案确认闸协议:awaiting_confirm 状态与两跑拆分](knowledge/plan-confirmation-gate.md) — 状态：有效（现行事实）；关键符号：`awaiting_confirm`、`runPlanPhaseSingle`、`PlanDiscussionSession`、`task:confirm-plan`
<!-- docs-harness:knowledge-index:end -->

<!-- docs-harness:acceptance-index:start -->
## 验收资产

- [工作流第一阶段验收:主方案→子实现→主审查](acceptance/workflow-stage1.md) — 状态：已验收-仅追溯；关键符号：`runWorkflow`、`sub_agent`、`review_round`
- [交互批 V0.2r2 验收:多项目清单、手动状态与会话面板](acceptance/interaction-batch-v03.md) — 状态：有效（待验收）；关键符号：`FollowUpSession`、`task:follow-up-send`、`sessionId`
- [macOS 风格前端重设计验收](acceptance/macos-ui-redesign.md) — 状态：已验收-仅追溯；关键符号：`ProjectColumn`、`AgentChainPicker`、`board-col`
- [dispatch 双半插件（@aiwaretop/dsh-dispatch）验收](acceptance/dispatch-dsh-plugin-v2.md) — 状态：已验收-仅追溯；关键符号：`DispatchApi`、`ipc-bridge`、`api-bridge`、`event-bridge`
- [dsh 追问面板与沙箱放行验收](acceptance/dsh-headless-session-panel.md) — 状态：已验收-仅追溯；关键符号：`dsh-headless-session`、`headless-dispatch`、`agents.resume`、`sandbox-policy`
- [工单档位路由验收](acceptance/task-tier-routing.md) — 状态：已验收-仅追溯；关键符号：`simple_direct_answer`、`effect_requires_work`、`prompt-real-template`、`judgeArtifacts`
- [项目看板列拖拽排序(桌面端 + dsh 插件)](acceptance/project-column-drag-reorder.md) — 状态：已验收-仅追溯；关键符号：`project:reorder`、`ProjectStore.reorder`、`sort_order`、`ProjectColumn`
- [B5 Windows 适配验收](acceptance/b5-windows-adaptation.md) — 状态：已验收-仅追溯；关键符号：`win32Ops`、`PlatformOps`、`spawnShellDetached`、`getPlatformOps`
- [方案确认闸验收:执行前用户确认与多轮方案讨论](acceptance/plan-confirmation.md) — 状态：已验收-仅追溯；关键符号：`awaiting_confirm`、`PlanDiscussionSession`、`task:confirm-plan`、`runPlanPhase`
<!-- docs-harness:acceptance-index:end -->

<!-- docs-harness:adr-index:start -->
## 架构决策

<!-- docs-harness:adr-index:end -->
