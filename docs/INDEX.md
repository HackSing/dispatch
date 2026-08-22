# 项目文档索引

项目文档从这里进入；Docs Harness 只维护下方任务方案区块。

<!-- docs-harness:plans-index:start -->
## 任务方案

- [工作流第一阶段:主智能体方案 → 子智能体实现 → 主智能体审查](plans/workflow-stage1.md) — 状态：已实施-仅追溯（代码已是真源，2026-08-22 核对）；关键符号：`sub_agent`、`runWorkflow`、`review_round`、`wf-implement`
- [交互批 V0.2r2:追问改为常驻会话面板(单 worktree 多轮对话,结束一次合并)](plans/interaction-batch-v03.md) — 状态：有效（实施中）；关键符号：`FollowUpSession`、`resume_stream_args`、`task:follow-up-send`、`rounds.jsonl`
- [主窗看板化与 macOS 风格前端重设计](plans/macos-ui-redesign.md) — 状态：已实施-仅追溯（代码已是真源，2026-08-22 核对）；关键符号：`ProjectColumn`、`AgentChainPicker`、`board-col`、`capture-pop`
<!-- docs-harness:plans-index:end -->

<!-- docs-harness:knowledge-index:start -->
## 项目知识

<!-- docs-harness:knowledge-index:end -->

<!-- docs-harness:acceptance-index:start -->
## 验收资产

- [工作流第一阶段验收:主方案→子实现→主审查](acceptance/workflow-stage1.md) — 状态：已验收-仅追溯；关键符号：`runWorkflow`、`sub_agent`、`review_round`
- [交互批 V0.2r2 验收:多项目清单、手动状态与会话面板](acceptance/interaction-batch-v03.md) — 状态：有效（待验收）；关键符号：`FollowUpSession`、`task:follow-up-send`、`sessionId`
- [macOS 风格前端重设计验收](acceptance/macos-ui-redesign.md) — 状态：已验收-仅追溯；关键符号：`ProjectColumn`、`AgentChainPicker`、`board-col`
<!-- docs-harness:acceptance-index:end -->

<!-- docs-harness:adr-index:start -->
## 架构决策

<!-- docs-harness:adr-index:end -->
