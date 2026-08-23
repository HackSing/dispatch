# @aiwaretop/dsh-dispatch

Dispatch（任务收件箱 + Agent 调度器）的 dsh 插件形态：把独立桌面应用的完整能力装进
dsh-buddy —— 任务捕获、30s 调度、git worktree 隔离执行、会话追问、归档，全部经
`/api/dispatch/*`（HTTP + SSE）暴露给浏览器侧面板。

## 形态

- **host 半**（`src/host/`）：跑在 dsh 服务进程内（Electron-as-Node）。core 运行时
  （`vendor/dispatch-core.mjs`，esbuild 产物）+ 32 个 invoke 通道桥 + SSE 事件流。
- **client 半**（`src/client/` → `lib/client.js`）：dsh 侧栏注入「任务派单」入口，
  点击在中列（centerCol）接管出任务视图（task-board 同款：常驻 DOM、
  `<html data-dispatch-panel-active>` 切显隐、与 task-board/ssh 互相让位），
  renderer 组件源码级复用，React 19 自包含 bundle + Shadow DOM 样式隔离。

## 安装

```bash
dsh plugin --profile web add @aiwaretop/dsh-dispatch
```

重启 dsh-buddy 生效。侧栏「新建会话」之后出现「任务派单」入口。

## 数据目录与双开

默认与独立 Dispatch app 共享 `~/.dispatch`（config.json / dispatch.db / prompts /
archives 完全互通）。**不要同时运行独立 app 与本插件**（SQLite 单写者）；
需要隔离时给 dsh 进程设 `DISPATCH_HOME`。

配置单一来源是 `~/.dispatch/config.json`（agent 校准、并发、超时等），本插件不引入
第二套配置。

## 全局快捷键（需 dsh-buddy ≥ 快捷键版）

dsh-buddy 壳注册系统级 `CommandOrControl+Shift+Space`，按下 → 壳前置窗口 → 页面
`dsh-buddy-hotkey` 事件 → Dispatch 面板与捕获输入框直出。环境变量：

- `DSH_BUDDY_HOTKEY=<accelerator>` 覆盖键位
- `DSH_BUDDY_HOTKEY=off` 关闭

旧壳无此机制时退化为侧栏入口 + 面板内「＋ 快捷新建」。

## 插件形态的能力降级

| 通道 | 独立 app | 插件形态 |
| --- | --- | --- |
| `project:pick-directory` | 系统目录对话框 | 三级串联：宿主 native 系统对话框 → 目录浏览器（dsh directoryPicker browse）→ 手动输入兜底 |
| `task:open-session-terminal` | 交互式终端 | 不支持（会话追问面板为主交互） |
| `task:open-archive` | 打开归档目录 | 不支持（详情页显示归档路径） |

## 卸载

```bash
dsh plugin --profile web remove @aiwaretop/dsh-dispatch
```

`~/.dispatch` 数据保留，可随时回到独立 app。

## 开发（dispatch 仓内）

```bash
cd dsh-plugin
npm run build     # seed-vendor(core bundle + Electron-ABI better-sqlite3 + prompts) + build-client
npm test          # Electron-as-Node 下 node --test(host 半 9 用例)
npm pack          # build + verify + tarball
```

**ABI 纪律**：vendor 里的 `better_sqlite3.node` 必须是 Electron ABI（dsh 服务进程 =
Electron + ELECTRON_RUN_AS_NODE）。它由父仓 `npm install` 的 postinstall
（electron-builder install-app-deps）物化，seed-vendor 只复制 —— 换 Electron 大版本
时需重装父仓依赖并重跑 build。不要让 pnpm 在用户机器上重装此依赖
（Node ABI 在 dsh 进程内无法加载，见批次 0 spike 结论）。

**loader 契约**：`lib/client.js` 必须是 `window.__ModuleLoader__.load({id, factory})`
形状，factory 只收 `require`（module/exports 在 banner 自声明），导出 `apply`。
