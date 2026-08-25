> 状态：已验收-仅追溯
<!-- docs-harness:acceptance-document/v1 -->

# B5 Windows 适配验收

- 修订：2
- 关键符号：`win32Ops`、`PlatformOps`、`spawnShellDetached`、`getPlatformOps`
- 资产指纹：`sha256:8e65023bdd652a1e919b6cf61d3bf9f34212be9453ec3ef4bad123a9a80cda44`
- 关联方案：`docs/plans/b5-windows-adaptation.json`

## 验收目标

win32-x64 上 dispatch core 全功能可用且 darwin 零回归:platform 层三操作实测通过、core 单测双平台全绿、B2 全链路 Windows 实机跑通、NSIS 装包可用、dsh-dispatch 0.1.4 面板正常加载。

## 验收标准

### `c1` L1 契约:npm run lint 与 typecheck 在 Windows 本机通过

- 状态：passed
- 类型：contract_check
- 层级：L1
- 证据：`docs/acceptance/evidence/b5-windows-adaptation/b2-reviewer-verification.md`、`docs/acceptance/evidence/b5-windows-adaptation/b3-reviewer-verification.md`

### `c2` L2 聚焦测试:npm test 在 Windows 本机全绿,含 win32 平台单测(killTree 真杀进程树、findBinary 解析真实 shim、shell 执行)

- 状态：passed
- 类型：behavior_acceptance
- 层级：L2
- 证据：`docs/acceptance/evidence/b5-windows-adaptation/b1-reviewer-verification.md`、`docs/acceptance/evidence/b5-windows-adaptation/b2-reviewer-verification.md`

### `c3` L2 CI:GitHub Actions windows job 全绿且 macOS job 不回归

- 状态：passed
- 类型：behavior_acceptance
- 层级：L2
- 证据：`docs/acceptance/evidence/b5-windows-adaptation/c3-ci-matrix.md`

### `c4` L3 全链路:Windows 实机真实小仓库+真实 agent 跑通捕获→立即执行→自动合并→详情页(B2 链路)

- 状态：passed
- 类型：behavior_acceptance
- 层级：L3
- 证据：`docs/acceptance/evidence/b5-windows-adaptation/c4-b2-chain-live.md`、`docs/acceptance/evidence/b5-windows-adaptation/c4-probe-b2-chain.mjs`

### `c5` L3 插件:dsh-dispatch 0.1.4 装入 web profile 后 Dispatch 面板加载,不再 runtime-unavailable,五个 agent detect 实测并如实标注

- 状态：passed
- 类型：behavior_acceptance
- 层级：L3
- 证据：`docs/acceptance/evidence/b5-windows-adaptation/c5-dsh-plugin-live.md`、`docs/acceptance/evidence/b5-windows-adaptation/c5-probe-detections.mjs`

### `c6` L4 安装:electron-builder NSIS 安装包在 Windows 实装且应用可启动可用

- 状态：passed
- 类型：behavior_acceptance
- 层级：L4
- 证据：`docs/acceptance/evidence/b5-windows-adaptation/c6-nsis-install.md`
