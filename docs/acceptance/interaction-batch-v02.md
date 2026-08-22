> 状态：有效（待验收）
<!-- docs-harness:acceptance-document/v1 -->

# 交互批 V0.2 验收:多项目清单、手动状态与会话接力

- 修订：1
- 关键符号：`sessionId`、`parentTaskId`、`task:follow-up`
- 资产指纹：`sha256:d276a10ac395e1f5ebf9713362191346e29b168425b7c25ab0ce658726ea2fda`
- 关联方案：`docs/plans/interaction-batch-v02.json`

## 验收目标

多项目清单页(空项目可见/折叠/过滤)、done→todo 双向勾选、session 落库与接力任务(--resume 续会话走完整合并管线)及终端逃生舱全部按 Plan interaction-batch-v02 落地并以真实证据验收

## 验收标准

### `c1` 契约与执行层聚焦测试全绿:状态机 done→todo、config 新字段兼容、adapter fresh/resume argv、followUpTask 守卫、session 预生成落库、migration v3

- 状态：pending
- 类型：behavior_acceptance
- 层级：L2
- 证据：尚无

### `c2` 实机门控:claude-code 真实任务 done 后追问,接力任务在新 worktree 以同 session 执行并合并 done,归档证明会话记忆连续(暗号法)

- 状态：pending
- 类型：behavior_acceptance
- 层级：L3
- 证据：尚无

### `c3` 终端逃生舱:详情页按钮拉起 Terminal 并进入该任务 session 的交互式 resume

- 状态：pending
- 类型：behavior_acceptance
- 层级：L3
- 证据：尚无

### `c4` 用户真实使用确认:多项目清单/过滤/双向勾选/追问一轮体验通过

- 状态：pending
- 类型：user_acceptance
- 层级：L5
- 证据：尚无
