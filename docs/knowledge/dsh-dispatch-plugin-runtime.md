> 状态：有效（现行事实）
<!-- docs-harness:knowledge-document/v1 -->

# dsh-dispatch 插件的运行时 ABI 与 loader/UI 呈现契约

- 修订：4
- 关键符号：`seed-vendor.mjs`、`build-client.mjs`、`mountPanelView`、`mountSidebarEntry`
- 资产指纹：`sha256:25f03effb0e97674077dc2bc63c470c18447bedbb60bf988781ec3a4ae147b7e`

## 摘要

dsh 服务进程是 Electron-as-Node(ABI 139),插件必须 vendor Electron-ABI better-sqlite3;client bundle 须为自声明 module 的 __ModuleLoader__ 懒 CJS 形状;UI 呈现为 task-board 同款中列接管视图,renderer 弹层须 Shadow DOM 兼容(外点判定用 composedPath)。

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

### `shadow-dom-popover-compat`

插件 client 的 React 树渲染于 open shadow root,事件跨 shadow 边界后 document 层看到的 target 重定向为 shadow host:renderer 弹层代码的外点关闭判定必须用 event.composedPath().includes(wrapRef.current) 而非 contains(e.target)(后者恒判外点,弹层内任何点击会在 click 前被 mousedown 误关);usePopoverDismiss 的全部消费点(AgentChainPicker/TaskMenu/ProjectColumn/SessionPanel)共用该约束,独立 app light DOM 下两种写法等价。dsh plugin add 对同路径 file: tarball 内容变更不重装,重装须先 remove 再 add。

证据：`src/renderer/src/lib/use-popover.ts`、`dsh-plugin/src/client/panel.tsx`

### `pack-files-prompts`

dsh-plugin package.json 的 files 排除项必须收窄为 !vendor/node_modules/**/*.md:曾用 !vendor/**/*.md 误杀 vendor/prompts/*.md,tgz 从不含内置提示词模板,面板首轮 renderFirstTurn 缺 follow-up.md 静默失败、relay 任务滞留 running(2026-08-22 修复);批量任务此前未暴露仅因 ~/.dispatch/prompts 恰有 default.md 兜底

证据：`dsh-plugin/package.json`、`docs/acceptance/evidence/dshs-c3-e2e.txt`
