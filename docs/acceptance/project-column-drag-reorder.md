> 状态：已验收-仅追溯
<!-- docs-harness:acceptance-document/v1 -->

# 项目看板列拖拽排序(桌面端 + dsh 插件)

- 修订：6
- 关键符号：`project:reorder`、`ProjectStore.reorder`、`sort_order`、`ProjectColumn`
- 资产指纹：`sha256:23d8a2ebd63a80d0af53f283d743854c94a201ea807ab1bd64dbec8631c5724f`
- 关联方案：`docs/plans/project-column-drag-reorder.json`

## 验收目标

看板项目列支持拖拽排序并持久化,桌面端与 dsh 插件同一份 renderer 实现同时生效;插件 host 的 ipc-bridge 同步新增通道。

## 验收标准

### `c1` ProjectStore.reorder 持久化顺序:list 按 sort_order 返回,reorder 后顺序与重启后一致

- 状态：passed
- 类型：behavior_acceptance
- 层级：L2
- 证据：`docs/acceptance/evidence/project-column-drag-reorder/c1-focused-test.txt`

### `c2` project:reorder 通道契约:桌面端 ipc-handlers 与插件 ipc-bridge 均实现且注册进 INVOKE_CHANNELS

- 状态：passed
- 类型：contract_check
- 层级：L1
- 证据：`docs/acceptance/evidence/project-column-drag-reorder/c2-contract.txt`、`docs/acceptance/evidence/project-column-drag-reorder/c2-plugin-host-test.txt`

### `c3` 看板列拖拽交互:从 grip 手柄拖动列到目标位置,松手后顺序立即更新(桌面端与插件共用 renderer)

- 状态：passed
- 类型：behavior_acceptance
- 层级：L3
- 证据：`docs/acceptance/evidence/project-column-drag-reorder/c1-focused-test.txt`
