> 状态：有效（待验收）
<!-- docs-harness:acceptance-document/v1 -->

# 交互批 V0.2r2 验收:多项目清单、手动状态与会话面板

- 修订：1
- 关键符号：`FollowUpSession`、`task:follow-up-send`、`sessionId`
- 资产指纹：`sha256:9594f4f0fb7aba180606c1e0ddcca83255c5bba3ba6ec334646895b52f91e469`
- 关联方案：`docs/plans/interaction-batch-v03.json`

## 验收目标

多项目清单页与双向勾选(已实施待确认)、会话面板(单 worktree 多轮同 session 对话+一次合并)及终端逃生舱按 Plan interaction-batch-v03 落地并以真实证据验收

## 验收标准

### `c1` 聚焦测试全绿:会话引擎两种传输、startFollowUpSession 守卫、同步块状态驱动、轮超时、rounds.jsonl 形状、config 新字段兼容(含 B-a 契约层既有测试)

- 状态：pending
- 类型：behavior_acceptance
- 层级：L2
- 证据：尚无

### `c2` 实机门控:done 任务开面板连发两轮(暗号法证明同 session 上下文连续),完成合并落 done,归档含 rounds.jsonl 与全轮文本;终止后重开面板仍续同一 session

- 状态：pending
- 类型：behavior_acceptance
- 层级：L3
- 证据：尚无

### `c3` 终端逃生舱:详情页按钮拉起 Terminal 并进入该任务 session 的交互式 resume;面板关闭与应用退出后无残留 agent 进程

- 状态：pending
- 类型：behavior_acceptance
- 层级：L3
- 证据：尚无

### `c4` 用户真实使用确认:多项目清单/过滤/双向勾选/面板多轮打磨一轮真实体验通过

- 状态：pending
- 类型：user_acceptance
- 层级：L5
- 证据：尚无
