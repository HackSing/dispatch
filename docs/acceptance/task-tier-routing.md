> 状态：已验收-仅追溯
<!-- docs-harness:acceptance-document/v1 -->

# 工单档位路由验收

- 修订：7
- 关键符号：`simple_direct_answer`、`effect_requires_work`、`prompt-real-template`、`judgeArtifacts`
- 资产指纹：`sha256:7af409e6ea2fa08c99ae851c27b5f6a5c6dcd22aded5681696fac5a51b739bae`
- 关联方案：`docs/plans/task-tier-routing.json`

## 验收目标

answer/work 双档路由生效:问答任务提速且可审计,工单任务纪律不减,模板契约回归全绿

## 验收标准

### `r1` 问答任务:answer 档 done、端到端 <45s、notes 首行 routing 可审计

- 状态：passed
- 类型：behavior_acceptance
- 层级：L4
- 证据：`docs/acceptance/evidence/route-r1-r3.txt`

### `r2` 写文件任务:work 档产物齐全(五小节 plan.md + 验证留痕)

- 状态：passed
- 类型：behavior_acceptance
- 层级：L4
- 证据：`docs/acceptance/evidence/route-r1-r3.txt`

### `r3` 误判防线:伪装问答的改文件任务被路由 work 档

- 状态：passed
- 类型：behavior_acceptance
- 层级：L4
- 证据：`docs/acceptance/evidence/route-r1-r3.txt`

### `r4` 模板契约回归:prompt-real-template 全绿(锚点行/TASK_TEXT 约束保持)

- 状态：passed
- 类型：behavior_acceptance
- 层级：L2
- 证据：`docs/acceptance/evidence/route-r1-r3.txt`
