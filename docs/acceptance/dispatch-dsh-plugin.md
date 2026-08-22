> 状态：有效（待验收）
<!-- docs-harness:acceptance-document/v1 -->

# dispatch 双半插件（@aiwaretop/dsh-dispatch）验收

- 修订：7
- 关键符号：`DispatchApi`、`ipc-bridge`、`api-bridge`、`event-bridge`
- 资产指纹：`sha256:a7098155cd60b73762213d3c8ab330837c22279aa51ec9c353c2ccb72a89a15e`
- 关联方案：`docs/plans/dispatch-dsh-plugin.json`

## 验收目标

验证 dispatch 以 dsh 双半插件形态在 dsh-buddy 内完整可用：host 半在真实 dsh 服务进程内提供 HTTP+SSE 全链能力并共享 ~/.dispatch 数据；client 半在 dsh-buddy 界面内完成任务面板全流程；系统快捷键捕获弹窗可用；禁用/卸载后无遗留。

## 验收标准

### `c1` 批次 0 spike 结论：better-sqlite3 ABI 选型与 core bundle 冒烟

- 状态：passed
- 类型：contract_check
- 层级：L1
- 证据：`.harness-tmp/evidence-batch1.md`

### `c2` 桥接层单测：28 个 invoke 通道映射与事件桥正确性

- 状态：passed
- 类型：behavior_acceptance
- 层级：L2
- 证据：`.harness-tmp/evidence-batch1.md`

### `c3` host 半实机全链：curl 建任务→执行→SSE task:changed→归档落盘，共享 ~/.dispatch 与独立 app 数据互通

- 状态：passed
- 类型：behavior_acceptance
- 层级：L3
- 证据：`.harness-tmp/evidence-batch1.md`

### `c4` client 半实机 UI 全流程：dsh-buddy 内建任务→进度→会话追问（流式）→归档查看

- 状态：passed
- 类型：behavior_acceptance
- 层级：L3
- 证据：`.harness-tmp/evidence-batch2.md`

### `c5` 系统快捷键捕获弹窗：任意应用聚焦时按键→dsh-buddy 前置+弹窗→入库

- 状态：pending
- 类型：behavior_acceptance
- 层级：L5
- 证据：`.harness-tmp/evidence-batch3.md`

### `c6` 禁用/卸载插件后 dsh 正常启动且无遗留调度子进程

- 状态：passed
- 类型：behavior_acceptance
- 层级：L3
- 证据：`.harness-tmp/evidence-batch1.md`、`.harness-tmp/evidence-batch3.md`
