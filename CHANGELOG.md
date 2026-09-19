# Changelog

本项目所有显著变更记录于此;版本号遵循语义化版本,新条目置顶。

## [Unreleased]

### 实时日志修复:方案阶段即可看到 agent 输出(2026-09-19)
- 根因:执行器在 `running` 迁移之后才建归档目录,`archive_dir` 直到 awaiting_confirm 才入库——期间 `task:archive` 轮询拿不到归档路径,详情页「执行日志(实时)」整段空白(79a5c9c5 实录:方案阶段 5 分钟全程"暂无过程输出")
- 修复:Phase 0 建归档后即刻经新增 `TaskStore.setArchiveDir` 入库(running 态记账,不触发 onChange);磁盘上的 output.log 本就逐事件落盘,无需改写盘机制(其间曾怀疑 fs.WriteStream 攒盘并重写为同步追加,插桩证明误判后已回滚)
- 验证:真实微型任务 4.1s 日志首次可见、运行期持续增长;新增 executor 回归单测(running 中 archiveDir 必须非空)

### 合并闸精确化:未跟踪文件不碰撞即放行(2026-09-19)
- 此前 `advanceBase` 对主检出区任何 porcelain 脏条目(含未跟踪文件)一律 base_dirty 拦停;实录 79a5c9c5 被两个与 incoming 提交零交集的插件目录(.v2c/.video_agent)挡停 10 分钟,而快进根本不写未跟踪路径
- 新增 `inspectDirty` 拆分 tracked/untracked:tracked 改动仍拦;仅未跟踪时与 incoming diff(`git diff --name-only <base> <task>`)求路径交集,无交集放行(目录坍缩形态按前缀匹配;git 自身对真实碰撞仍拒绝,双保险)
- `awaiting_merge` 的 failReason 携带挡路条目(`base_dirty: <文件,前5个,等N项>`),详情页人话展示"先处理这些条目再重试合并",不再让用户猜
- 回归测试:未跟踪放行/文件碰撞/目录坍缩碰撞/tracked 仍拦四态;既有 base_dirty 断言(tracked 场景)全部保持

### 修复:方案讨论会话并发双开泄漏孤儿进程(2026-09-19)
- StrictMode 开发期双挂载 × `SessionService.openPlanDiscussion` 幂等检查与登记之间的 await 窗口 → 同任务同秒拉起两个 `claude --resume`,未入表的孤儿进程退出应用也不回收(79a5c9c5 实录 PID 79824/79825)
- 修复:开启过程以 in-flight promise 共享(`discussionOpens` 表),并发调用复用同一次 start;新增并发双开单测(start 仅一次、结果同源)

### 主窗右下角新增「新建任务」悬浮入口(2026-09-19)
- 此前主窗只能新建项目,新建任务仅全局快捷键一条路,不可发现;现于主窗右下角增加悬浮按钮,点击经新增 `capture:show` IPC 通道唤起与快捷键同一捕获窗(无项目空态同样可见)
- 按钮提示展示当前全局快捷键;层级置于看板内容之上、抽屉与确认框之下

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
