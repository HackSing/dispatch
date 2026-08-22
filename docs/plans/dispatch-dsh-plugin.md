> 状态：有效（实施中）
<!-- docs-harness:plan-document/v1 -->

# dispatch 插件化为 dsh 双半插件（@aiwaretop/dsh-dispatch）

- 冻结合同：`sha256:a00ec3c36dfe9ff2dd4d0679eea6cef792630b16befb54bdfc012673a873a2ab`
- 关键符号：`DispatchApi`、`INVOKE_CHANNELS`、`ipc-bridge`、`event-bridge`

## 背景

用户要求把 dispatch（Electron 任务收件箱 + Agent 调度器）包装成 dsh-buddy 的插件。dsh-buddy 的插件协议属于 @deepseek-ai/dsh（cordis 框架）：插件 = npm 包，host 半跑在 dsh 服务进程（Electron 38 + ELECTRON_RUN_AS_NODE=1）内，client 半跑在浏览器（contextIsolation、无 Electron 能力）。/Users/aiware/projects/docs-harness/dsh-plugin 已验证外部项目插件化的完整模式（seed-vendor 物化引擎 + esbuild client + fake-cordis 测试脚手）。dispatch 分层恰好适配：src/core + src/shared 零 electron 引用（已验证），renderer 只依赖 window.dispatchApi（DispatchApi 契约：invoke/on，src/shared/ipc.ts 为唯一来源，28 invoke 通道 + 5 事件通道）。用户正在主工作树调整 UI，实现全部隔离在 worktree feat/dsh-plugin 分支。

## 目标

dispatch 全部能力（任务捕获/调度/worktree 执行/会话追问/归档）可在 dsh-buddy 内使用：host 半移植 core 并以 HTTP+SSE 暴露能力，client 半源码级复用 renderer 组件渲染任务面板（侧栏入口+大面板），并经 dsh-buddy 壳新增的通用快捷键转发机制保留全局快捷键捕获弹窗。数据与独立 Dispatch app 共享 ~/.dispatch。

## 非目标

- 不修改用户正在调整的 renderer UI 代码（源码级复用，UI 演进由主工作树继续）
- 不进入 dsh-buddy 预装清单（稳定后另行决策，届时需补绿灯 license）
- 不退役独立 Dispatch app（两形态并存，仅声明勿双开）
- 不做 npm publish（批次 4 产出待发布物，publish 需用户最终确认）
- 不校准 dsh 作为 dispatch 执行 agent 的能力（套娃问题，另行任务）

## 成功标准

- 批次 1：真实 dsh 服务进程内 curl 建任务 → 执行 → SSE 收到 task:changed → 归档落 ~/.dispatch，且与独立 app 数据互通（可见历史任务）
- 批次 2：dsh-buddy 界面内完成「建任务 → 看执行进度 → 会话追问（SSE 流式）→ 归档查看」全流程
- 批次 3：任意应用聚焦时按快捷键 → dsh-buddy 前置 + 捕获弹窗 → 回车任务入库
- 卸载/禁用插件后 dsh 正常启动、无遗留调度子进程
- dispatch 仓现有测试套件在 worktree 内通过（现有文件零改动或仅 db 层受控改动）

## 执行范围

- dispatch 仓 worktree ../dispatch-dsh-plugin（分支 feat/dsh-plugin）：新建 dsh-plugin/ 目录（独立 npm 包）
- 批次 0 若 better-sqlite3 ABI 不可用：受控修改 src/core/db/ 迁移 node:sqlite（唯一允许触碰现有文件的分支路径）
- dsh-buddy 仓 worktree（批次 3）：main.js 增加通用全局快捷键转发机制
- docs/plans、docs/INDEX：本 plan 及配套文档登记

## 执行内容

- 批次 0 spike：(1) better-sqlite3 在 ELECTRON_RUN_AS_NODE=1 的 Electron 38 上下文加载验证（两种安装来源：系统 Node pnpm / Electron-as-Node 环境），失败则启动 node:sqlite 迁移路径；(2) esbuild 将 src/core+src/shared 打为单 ESM，Node 22 冒烟（临时 DISPATCH_HOME：bootstrap → 建任务 → 假 agent 跑完 → 归档落盘）
- 批次 1 host 半：dsh-plugin/ 骨架（package.json 含 cordis 协议字段、cordis.patch.yml、src/host/index.js）；apply(ctx) 启动 core + scheduler，ctx.effect 注册 disposer（停调度/中断在跑任务，靠 core recovery 兜底）；ipc-bridge.js 从 src/shell/ipc-handlers.ts 移植 28 通道映射（pick-directory→手输路径+host 校验、open-session-terminal→not_supported、open-archive→返回路径、capture:hide→client 自理）；event-bridge.js 将 5 事件桥接为 GET /api/dispatch/events SSE；invoke 桥 POST /api/dispatch/invoke/:channel 白名单=INVOKE_CHANNELS + loopback 校验（照抄 docs-harness routes.js 安防）；配置单一来源 ~/.dispatch/config.json 不走 dsh settings 网关；fake-cordis/fake-context 单测
- 批次 2 client 半：api-bridge.ts 实现 DispatchApi（fetch/EventSource，与 preload 同形）；入口挂 window.dispatchApi 后直接渲染 App.tsx（零侵入复用）；React 19+Zustand+styles.css 打自包含 bundle；task-board 式模糊选择器注入侧栏入口 + 双 MutationObserver 自愈；body 级 React 根渲染面板（pet 先例）
- 批次 3 快捷键：dsh-buddy 壳 main.js 注册 globalShortcut（可配可关），按下 show+focus 主窗并 executeJavaScript 派发 dsh-buddy-hotkey CustomEvent；插件 client 监听事件弹捕获模态（复用 CaptureApp，capture:hide→关模态），旧壳降级为面板内 + 按钮
- 批次 4 发布准备：README（安装/勿双开/卸载）、npm pack 产物、harness 收尾（plan settle、assets-check）；publish 待用户确认

## 验收方案

acceptance create 建立验收目标并关联本 plan；每批次完成后 acceptance record 记录真实证据：批次 1 用 curl+独立 DISPATCH_HOME 开发验证、最终共享 ~/.dispatch 验收数据互通；批次 2 实机 dsh-buddy UI 全流程（含 SSE 流式会话）；批次 3 实机快捷键弹窗；每批受影响模块回归（dispatch vitest + 插件 node --test）后提交锁定。用户可见层（UI 全流程、快捷键体验）在证据不足以自证时列明复现步骤交用户最短确认。

## 是否需要 Acceptance 资产闭环

```json
true
```

## Knowledge 影响

updated

## 约束

- 对 dispatch 现有文件零改动（除批次 0 备选路径 db 层），新代码全部在 dsh-plugin/ 新目录，保证与用户 UI 调整零冲突
- 先复用后新写：core/shared/renderer 全部复用，新写仅限桥接层（ipc-bridge/event-bridge/api-bridge/client 入口/scripts），职责单一
- peerDependencies 钉 @deepseek-ai/dsh ^0.1.1-rc.1 基线；只用 settings.section/runtime 基础 slot，避开 keyed slot 红线
- 业务默认值单一来源：插件不引入新默认值，全部沿用 core 的 config 体系
- 每个错误要么处理要么上抛；host 半 fail-soft 不阻断 dsh 启动

## 风险与回滚

- better-sqlite3 ABI 不匹配（dsh 服务进程 vs 安装链路运行时）→ 批次 0 前置 spike；备选 node:sqlite 迁移（改动收敛 src/core/db/）
- dsh 服务进程内长驻调度+子进程泄漏 → disposer 全清理 + core recovery 兜底；卸载后验证无遗留进程
- 壳 DOM 类名带构建哈希导致注入失效 → 模糊选择器 + MutationObserver 自愈（task-board 三纪律）
- 双开写坏 SQLite → 启动 busy 检测报错 + 文档声明勿双开
- 回滚：dsh plugin remove / patch disables 禁用插件即完全回退；dispatch 主仓不合并 feat/dsh-plugin 分支即可丢弃全部改动

## 当前约束

- dsh 基线 @deepseek-ai/dsh@0.1.1-rc.1（dsh-buddy 内嵌），engines.node ^22.19.0 || >=24.0.0
- dsh-buddy 与 dispatch 均为 Electron 38；dsh 服务进程 = process.execPath + ELECTRON_RUN_AS_NODE=1
- dsh client runtime 侧 React 18，插件 client 需自带 React 19 自包含 bundle（pet 先例验证隔离共存）
- dsh settings 网关 rc.6+ 只放行白名单命名空间，插件配置必须走自有通道

## 候选方案

- 伴生桥模式（dispatch 独立 app 常驻 + 插件做轻量入口）：需给 dispatch 新增本地 HTTP 层且双进程管理复杂，用户已否决
- 先 host 半最小版（API+简版 UI）：后续仍要补全量 UI，返工大于收益，用户已否决
- core 发布独立 npm 包 + 插件依赖它：双包发布同步成本高，弃用；采用 seed-vendor 单包模式（docs-harness 先例）

## 真实取舍

- 源码级复用 renderer vs 复制改造：选复用，UI 演进自动流入插件，但 client bundle 需整棵打进 React 19（体积换零维护）
- better-sqlite3（现状，ABI 风险）vs node:sqlite（零原生依赖，需改 db 层）：spike 实测定，倾向能用则不动 db 层
- 快捷键放插件 vs 放壳：插件无系统级能力，必须改壳；做成通用转发机制而非 dispatch 专用，避免壳内业务耦合

## 最终决策

完整双半插件 + worktree 隔离执行（用户 2026-08-22 确认）：host 半整体移植 src/core 能力以 HTTP+SSE 暴露，client 半零侵入复用 renderer，数据共享 ~/.dispatch，先发 npm 手动安装验证。快捷键捕获经 dsh-buddy 壳通用转发机制保留。

## 边界与接口

对外接口唯一定义为 src/shared/ipc.ts 的 DispatchApi 契约：invoke 28 通道映射 POST /api/dispatch/invoke/:channel（白名单=INVOKE_CHANNELS，请求体=req，响应=res，错误统一 {ok:false,error:{code,message}}），事件 5 通道映射 GET /api/dispatch/events SSE（event 名=EventChannel，data=payload）。loopback 校验 + body 上限。client 侧 api-bridge 与 preload 同形，组件层无感知。

## 兼容与迁移

数据层零迁移：插件默认共享 ~/.dispatch（SQLite/config/prompts/archives 与独立 app 完全互通）。风险为双开 SQLite 单写冲突，以启动 busy 检测 + 文档声明控制。插件早期版本若触发 node:sqlite 迁移，db 层需保持 schema 与数据文件兼容（同一 dispatch.db，migrations 体系复用）。

## 回滚或替代路径

插件侧：dsh plugin remove 或 cordis patch disables 即完全禁用，~/.dispatch 数据保留可回独立 app；dispatch 仓：不合并 feat/dsh-plugin 即丢弃；dsh-buddy 仓：快捷键机制独立提交，revert 单提交即回退。

## 架构验收

实机三层验证：(1) dsh 服务进程内 host 半全链（curl+SSE）；(2) dsh-buddy UI 内全流程（面板操作+流式会话）；(3) 系统级快捷键弹窗。另以单测覆盖桥接层映射正确性（28 通道逐一）。卸载后无遗留进程验证。

## ADR 处理

本 plan 的架构决策（双半桥接形态、零侵入 UI 复用、共享数据目录）随 plan 冻结即可追溯；若批次 0 触发 node:sqlite 迁移（存储引擎更换，不可逆性高），再以 adr create 单独登记。

<!-- docs-harness:plan-governance:start -->
## 资产治理

- 关联验收：`docs/acceptance/dispatch-dsh-plugin.json`
- 需要 Acceptance：true
- Knowledge 影响：updated
<!-- docs-harness:plan-governance:end -->
