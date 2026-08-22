# Changelog

本项目所有显著变更记录于此;版本号遵循语义化版本,新条目置顶。

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
