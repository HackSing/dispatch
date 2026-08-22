> 状态：已验收-仅追溯
<!-- docs-harness:acceptance-document/v1 -->

# dsh 追问面板与沙箱放行验收

- 修订：8
- 关键符号：`dsh-headless-session`、`headless-dispatch`、`agents.resume`、`sandbox-policy`
- 资产指纹：`sha256:d3a11466f2601ba34565edc9698f9238688d06ea6515afb6a7db76b823b92372`
- 关联方案：`docs/plans/dsh-headless-session-panel.json`

## 验收目标

dsh 任务产物可落归档目录(no_plan 消除),追问面板以 round 传输点亮;dispatch core 零代码改动

## 验收标准

### `c1` fresh 运行:--session-id 指定会话 id,沙箱放行 cwd 外写入,exit 0

- 状态：passed
- 类型：behavior_acceptance
- 层级：L3
- 证据：`docs/acceptance/evidence/dshs-c1-fresh.txt`

### `c2` resume 运行:--resume 跨目录续接并引用上一轮内容

- 状态：passed
- 类型：behavior_acceptance
- 层级：L3
- 证据：`docs/acceptance/evidence/dshs-c2-resume.txt`

### `c3` dispatch 端到端:重装后 dsh 任务终态 done,plan.md/result.json 落归档,sessionId 落库

- 状态：passed
- 类型：behavior_acceptance
- 层级：L4
- 证据：`docs/acceptance/evidence/dshs-c3-e2e.txt`

### `c4` 面板链路:task:follow-up-start/send/finish 对 dsh 任务全通

- 状态：passed
- 类型：behavior_acceptance
- 层级：L4
- 证据：`docs/acceptance/evidence/dshs-c4-panel.txt`

### `c5` 用户在 DSH Buddy 面板实操确认 dsh 任务与追问可用

- 状态：passed
- 类型：user_acceptance
- 层级：L5
- 证据：`docs/acceptance/evidence/dshs-c4-panel.txt`
