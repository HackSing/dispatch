# Dispatch(派单)

桌面端「任务收件箱 + Agent 调度器」:全局快捷键随手记任务,到点由指定的 agent CLI 在隔离 worktree 中无人值守执行,产出方案与结果报告并归档,自动合并回基线分支。

## 当前能力(macOS)

- **零摩擦捕获**:`Cmd+Shift+Space` 唤起捕获窗,回车派单;支持立即 / 定时 / 普通待办三种形态。
- **单点执行**:一个 agent 全包两阶段协议(先写 plan.md 方案,再执行并写 result.json),完成判定不达标即失败,fail_reason 精确到环节。
- **工作流执行**:可选子智能体,构成「主智能体拟方案 → 子智能体实现 → 主智能体审查」三段接力;审查只评不改(执行器强制),不通过打回返工(上限 2 轮)。
- **Git 隔离与合并**:每任务独立 worktree 与 `task/` 分支,合并串行、冲突拦截、脏工作区等待重试;done/放弃即清理 worktree 与分支。
- **调度与恢复**:30s 扫描定时任务、崩溃恢复、错过补跑策略、awaiting_merge 周期重试。
- **可观测**:流式人话日志、系统通知(点击直达详情)、归档永久保留(方案/结果/审查报告/全量日志)。

已校准 agent:Claude Code、Codex、Kimi、Qwen(参数配置化,见 [docs/agent-calibration.md](docs/agent-calibration.md));dsh 待安装校准。

## 快速开始

```bash
npm install
npm run dev
```

应用常驻托盘,关窗不退出;**重启须经托盘菜单「退出」**(二次启动只会唤起已有实例)。数据与配置在 `~/.dispatch/`,提示词模板 `~/.dispatch/prompts/*.md` 可编辑。

## 开发

```bash
npm run typecheck && npm run lint && npm test   # 三连检查(测试跑在 Electron ABI 上)
RUN_REAL_CLAUDE=1 npm test -- real-claude       # 门控实机套件(消耗 agent 配额)
RUN_REAL_AGENTS=codex,kimi,qwen npm test -- real-agents
RUN_REAL_WORKFLOW=1 npm test -- real-workflow
```

## 文档导航

- [产品规格](docs/dispatch-spec.md) · [研发方案与批次](docs/dev-plan.md) · [业务流程图](docs/flows.md)
- [Agent 校准记录](docs/agent-calibration.md) · [资产索引](docs/INDEX.md)(Plan/Acceptance 治理经 docs-harness)

## 安全边界

无人值守执行使用各 CLI 的自动批准模式,agent 会在无人监督时修改文件与执行命令。缓解 = worktree 隔离 + 合并前冲突拦截 + 审查阶段把关(工作流模式)+ 全量日志留档。只接入可信项目。
