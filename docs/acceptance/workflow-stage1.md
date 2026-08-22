> 状态：有效（待验收）
<!-- docs-harness:acceptance-document/v1 -->

# 工作流第一阶段验收:主方案→子实现→主审查

- 修订：1
- 关键符号：`runWorkflow`、`sub_agent`、`review_round`
- 资产指纹：`sha256:4cfa4e58b4c8ec3184870f8415617298a90012e570998c02e6d23b54e9d1a699`
- 关联方案：`docs/plans/workflow-stage1.json`

## 验收目标

验证工作流模式(主智能体方案→子智能体实现→主智能体审查)全链路正确,且单点模式零回归。

## 验收标准

### `c1` 单点模式零回归:既有全量测试在改动后保持全绿

- 状态：pending
- 类型：behavior_acceptance
- 层级：L2
- 证据：尚无

### `c2` mock 三角色覆盖工作流全路径:pass 直通、reject→返工→pass、reject×3→failed(review_rejected)、审查越权修改→failed(review_modified)、各阶段独立超时与缺产物精确 fail_reason

- 状态：pending
- 类型：behavior_acceptance
- 层级：L2
- 证据：尚无

### `c3` 实机全链路:claude-code 主 + qwen 子跑通「方案→实现→审查 pass→自动合并」,并人为构造一次 reject 返工

- 状态：pending
- 类型：behavior_acceptance
- 层级：L3
- 证据：尚无

### `c4` 用户在真实应用中捕获工作流任务,确认子智能体选择器、阶段与轮次可见性、审查报告展示符合预期

- 状态：pending
- 类型：user_acceptance
- 层级：L5
- 证据：尚无
