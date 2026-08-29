# Changelog

本项目所有显著变更记录于此;版本号遵循语义化版本,新条目置顶。

## [Unreleased]

### 修复:确认框失效导致删除/放弃等危险操作无反应(2026-08-29)
- 根因:渲染进程(Electron sandbox)下原生 `window.confirm` 点「OK」也同步返回 `false`(实测复现:confirm-return=false,删除 IPC 从未发出),所有以它为闸的操作(删除任务/放弃任务/移除项目/会话完成与放弃)静默无效
- 修复:新增应用内确认对话框 `useConfirmDialog`(`ConfirmDialog.tsx`),四处用法全部替换;支持 Esc 取消 / Enter 确认 / 点遮罩取消,危险操作红色确认按钮

### 方案确认闸(2026-08-28,方案 docs/plans/plan-confirmation.md)
用户可见行为变化:任务在方案产出后**暂停待用户确认**,不再一口气跑完方案 + 执行。
- 新增 `awaiting_confirm` 状态:方案阶段判过后暂停,发系统通知「方案待确认」(点击直达详情页确认区),释放执行信号量并保留 worktree/归档/会话 id
- 详情页方案确认区:查看 plan.md、与主智能体多轮讨论修订方案(讨论落归档 `discussion.log`,只改方案不迁移任务状态)、一键「确认,开始执行」或「放弃」;确认后执行器跳过方案阶段直接执行,放弃 → failed(abandoned) 并清理 worktree
- 单点与工作流两种模式行为一致,该确认闸默认对所有可执行任务开启;无会话续接能力的 agent 只提供查看方案 + 确认/放弃(无讨论输入框)
- 应用重启后 `awaiting_confirm` 任务原样保留,可继续讨论或确认

**升级注意**:`~/.dispatch/prompts/` 会新增 `default-plan.md`(方案跑)、`default-exec.md`(执行跑)、`plan-discussion.md`(方案讨论)三个模板;旧 `default.md` 已失活(执行器不再引用,用户目录旧拷贝自然废弃)。**自行改过 `default.md` 的用户需把改动移植到新模板**——方案阶段纪律搬到 `default-plan.md`,执行阶段纪律搬到 `default-exec.md`。

### B5 Windows 适配(2026-08-25,方案 docs/plans/b5-windows-adaptation.md)
- platform 层 win32 实现:taskkill 进程树强杀、where 二进制探测(可执行扩展名筛选,兼容 npm 全局安装的 .cmd shim 布局)、cmd 终端拉起
- PlatformOps 新增 buildSpawn 收敛点:.cmd/.bat 经 cmd.exe 执行(CVE-2024-27980 后 Node 限制),转义移植 cross-spawn;含换行参数在 .cmd shim 场景显式报错并提示改用原生 exe 或 stdin 传参
- 测试跨平台:npm test 经零依赖启动器在 Windows 全绿(221 用例);worktree 清理对 win32 目录锁形态(进程 cwd 占用)有限重试+残留补删
- CI 双平台矩阵(macos + windows);electron-builder 新增 NSIS 打包(pack:win)
- dsh-dispatch 插件 0.1.4:vendor 重打包含 win32 支持的 core;修复 agent 检测同步抛错炸穿 runtime 装配的缺陷(此前 Windows 上面板恒报 runtime-unavailable 的直接原因)

## [0.1.0-dev] - 2026-08-22

首个功能完整的开发版本,单日内按批次交付(细节见 docs/dev-plan.md 与 git 历史):

### 工作流第一阶段(W1)
- 可选子智能体:主智能体拟方案 → 子智能体实现 → 主智能体审查的三段接力
- 审查只评不改(worktree 快照强制)、打回返工上限 2 轮、每阶段独立超时
- phase 展示字段(不进状态机)、审查报告归档、返工留痕(result-r&lt;n&gt;.json)
- 实机验收:直通(claude+qwen)与返工(真实审查者拦截破坏性实现)均通过

### 清理闭环
- 放弃任务即同步删除 worktree 与任务分支;failed 任务提供「清理 worktree」入口(可重入)

### B3 调度与多 agent
- 30s 定时扫描、崩溃恢复(含孤儿 worktree 回填)、错过补跑策略、awaiting_merge 周期重试
- codex/kimi/qwen 实机校准;系统通知、失败重跑、冲突「重试合并/放弃」

### 体验优化
- claude 流式人话日志(stream-json + 配置化过滤器)、执行耗时逐秒显示、归档文件列表与 Finder 直达

### B2 执行闭环(M1)
- 两阶段工单协议(plan.md → result.json)、完成判定、worktree 创建与安全合并、冲突报告、任务详情页
- 提示词模板(docs-harness 工作流规则的无人值守改写版)

### B1 捕获与任务库
- 全局快捷键捕获窗、项目管理(default 项目自动 git init)、agent 两级检测、主窗任务列表与编辑

### B0 工程骨架
- Electron + React + TS,core 与壳解耦;类型化 IPC、SQLite 迁移框架、状态机收口、托盘常驻
- 测试跑在 Electron ABI(ELECTRON_RUN_AS_NODE),原生模块单一编译
