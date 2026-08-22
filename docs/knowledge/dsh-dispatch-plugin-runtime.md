> 状态：有效（现行事实）
<!-- docs-harness:knowledge-document/v1 -->

# dsh-dispatch 插件的运行时 ABI 与 loader 契约

- 修订：1
- 关键符号：`seed-vendor.mjs`、`build-client.mjs`、`dispatch-core.mjs`、`hotkeyChildEnv`
- 资产指纹：`sha256:55da87edb7b0e86fe96d1d0a606174944d3b7e6704100cbd4f4a69b160a0faec`

## 摘要

dsh 服务进程是 Electron-as-Node(ABI 139),插件必须 vendor Electron-ABI better-sqlite3 且 client bundle 须为自声明 module 的 __ModuleLoader__ 懒 CJS 形状。

## 事实

### `abi-vendor-discipline`

dsh 服务进程 = Electron 38 + ELECTRON_RUN_AS_NODE=1(NODE_MODULE_VERSION 139):better-sqlite3 必须以 Electron ABI 物化进 vendor(seed-vendor 从父仓 postinstall 产物复制),插件包不得声明 better-sqlite3 依赖(pnpm v10 脚本审批或 Node ABI 重编都会使其在 dsh 进程内不可加载,系统 Node 跑 dsh CLI 时插件正确降级 runtime-unavailable)。

证据：`dsh-plugin/scripts/seed-vendor.mjs`、`dsh-plugin/README.md`

### `client-loader-contract`

dsh client loader 的 factory 只保证传 require:build-client 须在 banner 自声明 var module/exports 并在 footer return module.exports;入口导出名为 apply(activate 会被判 invalid plugin);client 对宿主 React 18 不可 external,React 19 自包含 bundle 与宿主隔离共存。

证据：`dsh-plugin/scripts/build-client.mjs`、`dsh-plugin/src/client/index.tsx`

### `shell-hotkey-bridge`

浏览器插件无系统快捷键能力:dsh-buddy 壳(分支 feat/dispatch-hotkey)注册 globalShortcut 并经 win.evalInContent 派发 dsh-buddy-hotkey CustomEvent,注册状态经 spawn env(DSH_BUDDY_HOTKEY_REGISTERED/ACCELERATOR)透出,插件 host 据此回报 app:hotkey-status。

证据：`dsh-plugin/src/host/ipc-bridge.js`、`dsh-plugin/src/client/index.tsx`
