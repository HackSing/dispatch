> 状态：已验收-仅追溯
<!-- docs-harness:acceptance-document/v1 -->

# macOS 风格前端重设计验收

- 修订：6
- 关键符号：`ProjectColumn`、`AgentChainPicker`、`board-col`
- 资产指纹：`sha256:d814cffdf47d340ca66a021bf2c57077c966f36971bdf86e0fe4d30ec0b2d64e`
- 关联方案：`docs/plans/macos-ui-redesign.json`

## 验收目标

renderer 按定稿画布完成 macOS 风格重构且既有功能不回归

## 验收标准

### `c1` typecheck 与 lint 全绿

- 状态：passed
- 类型：contract_check
- 层级：L1
- 证据：`.harness-tmp/evidence/c1-typecheck-lint.log`

### `c2` 受影响 renderer 测试通过(vitest)

- 状态：passed
- 类型：behavior_acceptance
- 层级：L2
- 证据：`.harness-tmp/evidence/c2-vitest-full.log`

### `c3` 本地运行四界面与画布定稿一致且操作烟囱通过

- 状态：passed
- 类型：behavior_acceptance
- 层级：L3
- 证据：`.harness-tmp/evidence/c3-dev-run.log`

### `c4` 用户目视确认界面符合预期

- 状态：passed
- 类型：user_acceptance
- 层级：L5
- 证据：
