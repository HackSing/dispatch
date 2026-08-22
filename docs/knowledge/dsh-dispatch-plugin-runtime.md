> 状态：有效（现行事实）
<!-- docs-harness:knowledge-document/v1 -->

# dsh-dispatch 插件的运行时 ABI 与 loader/UI 呈现契约

- 修订：2
- 关键符号：`seed-vendor.mjs`、`build-client.mjs`、`mountPanelView`、`mountSidebarEntry`
- 资产指纹：`sha256:c5408ea27badf9bee80ddc10dc5128c2aa629b2be5bbafea0e988d5bd8932d8f`

## 摘要

dsh 服务进程是 Electron-as-Node(ABI 139),插件必须 vendor Electron-ABI better-sqlite3;client bundle 须为自声明 module 的 __ModuleLoader__ 懒 CJS 形状;UI 呈现为 task-board 同款中列接管视图。

## 事实

### `abi-vendor-discipline`

dsh 服务进程 = Electron 38 + ELECTRON_RUN_AS_NODE=1(NODE_MODULE_ABI 139):插件须 vendor Electron-ABI better-sqlite3(seed-vendor 从父仓 postinstall 产物物化,bundle --external),不声明其依赖(pnpm v10 脚本审批会破坏)。

证据：`dsh-plugin/scripts/seed-vendor.mjs`、`dsh-plugin/README.md`

### `client-loader-contract`

dsh client loader 的 factory 只保证传 require:build-client 须在 banner 自声明 var module/exports、footer return module.exports,入口导出 apply(activate 会被判 invalid plugin)。

证据：`dsh-plugin/scripts/build-client.mjs`、`dsh-plugin/src/client/index.tsx`

### `shell-hotkey-bridge`

浏览器插件无系统快捷键能力:dsh-buddy 壳(分支 feat/dispatch-hotkey)注册 globalShortcut,按下时前置窗口并 evalInContent 派发 dsh-buddy-hotkey CustomEvent;注册状态经 spawn env(DSH_BUDDY_HOTKEY_REGISTERED)注入,host 的 app:hotkey-status 据此回报。

证据：`dsh-plugin/src/host/ipc-bridge.js`、`dsh-plugin/src/client/index.tsx`

### `center-column-takeover`

插件 UI 呈现走 task-board 同款中列接管:视图容器追加为 centerCol([data-pane=conversation] 旧壳兼容)子元素、position:absolute inset:0、React 树 apply 时挂一次,显隐只切 html[data-dispatch-panel-active] 属性并由 light DOM 规则隐藏中列兄弟;与 task-board/ssh 经 dsh-panel-activate 事件 + 互删 active 属性互相让位,点侧栏会话行(capture 相位)让位回对话;侧栏入口为 logoRow 后的原生导航行(dsw 令牌 + data-dsh-part=sidebar-entry),Shadow DOM 仅用于视图内部样式隔离。

证据：`dsh-plugin/src/client/panel.tsx`、`dsh-plugin/src/client/sidebar-entry.ts`、`dsh-plugin/README.md`
