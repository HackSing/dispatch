# Dispatch(派单)— 产品与技术规格 v0.1

> 桌面端「任务收件箱 + Agent 调度器」。全局快捷键快速记录任务,到点由指定的 agent CLI 在指定项目目录中自动执行,产出方案与结果报告并归档,支持日报聚合。
>
> 命名:Dispatch,中文「派单」。语义直给(把任务派给 AI 打工人),配置目录 `~/.dispatch`,任务分支前缀 `task/`。如需改名,全局 find-replace 即可,本文档以 Dispatch 为准。

---

## 1. 背景与定位

用户同时推进多个项目,任务在项目间来回切换导致注意力损耗、进度不透明。Dispatch 解决三件事:

1. **零摩擦捕获**:任何时刻一个快捷键记下任务,不打断当前工作。
2. **无人值守执行**:到达触发时间后,由任务指定的 agent CLI 在指定工作目录全自动完成任务。
3. **进度可见、结果可溯**:每个任务留下方案 + 结果报告 + 日志,按天聚合为日报。

非目标(v0.x 不做):多人协作、云同步、移动端、agent 托管(全部本地 CLI)。

---

## 2. 核心概念

| 概念 | 说明 |
|---|---|
| 任务 Task | 一条纯文本记录 + 三个属性:执行时间、智能体、项目 |
| 项目 Project | 一个工作文件夹(通常是 git 仓库)+ 项目级配置。内置 `default` 项目 |
| 智能体 Agent | 一个本机已安装的 agent CLI:Claude Code / Codex / DeepSeek (dsh) / Kimi CLI / Qwen Code |
| Adapter | 每个 agent CLI 对应一个适配器,统一为相同接口 |
| 工单流程 | 两阶段执行协议:先产出方案(plan),再执行并产出结果(result) |
| 归档 Archive | 每任务一个归档目录,存输入、方案、结果、日志、冲突报告 |

---

## 3. 用户流程

### 3.1 快速捕获(Quick Capture)

- 全局快捷键(默认 `Alt+Space`,可配置)唤起无边框置顶输入窗。
- 主体为纯文本输入框(支持多行),下方功能栏三个选择器:
  - **执行时间**:`立即` / `定时`(日期时间选择器)/ `空`(不执行,普通 todo)。默认 `空`。
  - **智能体**:仅列出检测通过的 agent(未检测到的置灰并标注原因)。执行时间为 `空` 时该项可不选。
  - **项目**:下拉列出已配置项目,默认 `default`;支持在此处快速新建项目(选文件夹)。
- 回车提交,窗口收起,任务入库。Esc 取消。
- 记忆上次选择的智能体与项目作为下次默认值。

### 3.2 主界面(任务清单)

- 常驻系统托盘,主窗口按项目分组展示任务列表,显示状态、触发时间、智能体。
- 单任务详情页:任务原文、方案(plan.md 渲染)、结果(result.json 渲染)、执行日志尾部、冲突报告(如有)。
- 操作:编辑(未执行前)、取消、立即执行、失败重跑(复制任务重新入队)、普通 todo 手动勾选完成。
- 系统通知:done / failed / conflict / awaiting_merge 四类事件触发。

---

## 4. 任务模型与状态机

### 4.1 字段

```
Task {
  id, created_at
  text            // 用户原始输入
  project_id
  agent           // claude-code | codex | dsh | kimi | qwen,todo 类任务可为空
  trigger         // immediate | at:<datetime> | none
  status          // 见 4.2
  base_branch     // 执行开始时项目主工作区所在分支(或项目配置的默认分支)
  branch          // task/<id>-<slug>
  worktree_path   // 执行期间的 worktree 路径
  archive_dir     // 归档目录
  fail_reason     // 失败原因(含 interrupted / no_result / bad_result 等)
  timestamps      // scheduled_at / started_at / finished_at / merged_at
}
```

### 4.2 状态机

```
todo ──────────────(补充执行时间+智能体)──────────┐
                                                  ▼
scheduled ──到点──▶ running ──▶ merging ──▶ done
                      │            │
                      │            ├─▶ awaiting_merge ──(条件满足后重试)──▶ merging
                      │            └─▶ conflict(保留 worktree,出冲突报告,等用户处理)
                      └─▶ failed(可一键重跑 = 复制新任务入队)
```

- `todo`:无执行时间的普通待办,仅手动勾选完成;后续可编辑升级为可执行任务。
- `scheduled`:等待触发(`immediate` 视为立刻到点)。
- `running`:含方案阶段与执行阶段(详见 §6)。
- `merging`:执行成功,正在合并回 base 分支。
- `awaiting_merge`:执行成功但暂不能安全合并(如用户主工作区脏),保留 worktree,通知用户;调度器周期性重试,用户也可手动触发。
- `conflict`:合并冲突,保留 worktree 与分支,生成冲突报告,等用户决定(在 worktree 手动解决后点「已解决,重试合并」,或放弃该任务)。
- `failed`:进程异常退出 / 超时 / result 协议不满足 / 应用重启时发现的孤儿 running 任务(fail_reason=interrupted)。
- `done`:已合并(或非 git 项目执行成功),worktree 已清理。

---

## 5. Agent 适配层

### 5.1 统一接口

```ts
interface AgentAdapter {
  id: string
  detect(): Promise<DetectResult>      // which + version 两级检测
  ensureReady(): Promise<void>         // 运行前置钩子,默认空实现
  run(opts: {
    prompt: string                     // 完整拼装后的提示词
    cwd: string                        // worktree 路径
    outDir: string                     // 归档目录(plan/result 写入处)
    timeoutMs: number
    onLog: (chunk: string) => void
  }): Promise<{ exitCode: number }>
}
```

### 5.2 五个 Adapter

| Agent | 二进制 | 备注 |
|---|---|---|
| Claude Code | `claude` | 无头:`claude -p`,自动批准 flag 从配置读取 |
| Codex | `codex` | 无头:`codex exec`,full-auto flag 从配置读取 |
| DeepSeek | `dsh` | **需守护进程先启动**:`ensureReady()` 执行 ready_check_cmd,失败则执行 start_cmd 拉起并轮询就绪 |
| Kimi | `kimi` | 本机已装,参数待确认 |
| Qwen | `qwen` | 非交互模式参数待确认 |

**原则:所有 CLI 的调用参数(无头 flag、自动批准 flag、ready_check_cmd、start_cmd)一律放配置文件,不硬编码。** 这些 CLI 迭代快,参数变更只改配置。构建时逐个对照本机 `--help` 确认填入初始值。

### 5.3 检测

- 时机:应用启动时 + 设置页手动刷新。
- 两级:`which <bin>` 存在性 → `<bin> --version`(或配置的等价命令)可运行性。
- 结果缓存入库,捕获窗口据此渲染可选项。

---

## 6. 执行流程(两阶段工单协议)

> ⚠️ 本节的任务流程规范需与 **docs/harness 中已有的任务流程文档**合并。下述为骨架,构建时以 harness 文档为准注入/覆盖具体流程步骤。提示词模板单独存为可编辑文件(`~/.dispatch/prompts/default.md`),不写死在代码里。

### 6.0 Phase 0 — 环境准备(调度器执行)

1. 创建归档目录 `archive_dir`。
2. git 项目:从 base 分支最新提交创建 worktree(见 §7);非 git 项目:直接以项目目录为 cwd,归档中记 `no_vcs`。
3. 执行项目配置的 `prepare_cmd`(如 `pnpm install --prefer-offline`),worktree 是干净检出,依赖不存在。prepare 失败 → 任务 failed。
4. 调用 adapter 的 `ensureReady()`。

### 6.1 Phase 1 — 方案(agent 执行,强制)

用户的任务原文可能写得不清楚。提示词要求 agent:

1. **理解**:阅读任务原文,主动探索仓库代码与文档,推断任务真实意图;有歧义时选择最合理假设,**假设必须记录在方案中**(全自动模式无人可问)。
2. **方案先行**:动手前将方案写入 `{OUT_DIR}/plan.md`,包含:任务理解(含假设清单)、优化后的目标描述/提示词、执行步骤、涉及文件、风险点。
3. 执行中如需偏离方案,须先在 plan.md 追加「变更记录」段落再继续。

### 6.2 Phase 2 — 执行与交付

结束前 agent 必须写 `{OUT_DIR}/result.json`:

```json
{
  "status": "success | partial | failed",
  "summary": "一段话:做了什么、结论是什么",
  "files_changed": ["相对路径", "..."],
  "follow_up": "可选:建议的后续任务",
  "notes": "可选:执行中的重要说明",
  "started_at": "ISO8601", "finished_at": "ISO8601"
}
```

### 6.3 完成判定(调度器)

任务执行成功 = **进程正常退出 且 plan.md 存在 且 result.json 存在且可解析且 status ≠ failed**。任一不满足 → failed,fail_reason 标明缺哪环,stdout/stderr 全量留档。

> plan.md 与 result.json 写入 **归档目录**(通过提示词传入绝对路径),不写入仓库/worktree,避免污染合并内容。

### 6.4 超时

单任务执行超时默认 30 分钟,项目级可覆盖。超时 → kill 进程树 → failed(fail_reason=timeout),worktree 保留供排查,由清理策略(§8.3)延后回收。

---

## 7. Git Worktree 策略

### 7.1 创建

- 位置:`~/.dispatch/worktrees/<project>/<task-id>/`(仓库外,不污染项目目录,无需改 .gitignore)。
- 命令等价:`git worktree add <path> -b task/<id>-<slug> <base_branch>`。
- base 取**执行开始时刻**的最新 base 分支提交(不是创建任务时刻),减少落后。

### 7.2 并行规则

- **同项目多任务并行执行:允许**(worktree 天然隔离)。
- **合并串行**:每项目一把合并锁,`merging` 一次只进一个任务。并行任务改到相邻区域时,后合并者冲突概率升高——这是预期行为,由冲突流程兜底。
- 全局并发上限默认 2(可配置),防止本机资源被打满。

### 7.3 合并流程(在 worktree 内完成,不碰用户主工作区)

1. 取项目合并锁。
2. 在 **task worktree 内** `git merge <base_branch>`(把 base 合进任务分支):
   - 冲突 → `git merge --abort`,任务置 `conflict`,生成冲突报告,worktree 与分支保留,通知用户。
   - 干净 → 任务分支已包含 base 全部提交,可安全快进。
3. 快进 base 分支到任务分支:
   - 用户主工作区**不在** base 分支上:直接 `git branch -f <base> task/<id>` 等价操作更新 ref。
   - 用户主工作区在 base 分支上且 **干净**:在主工作区 `git merge --ff-only task/<id>`。
   - 用户主工作区在 base 分支上且 **脏**:不动用户区,任务置 `awaiting_merge`,通知用户;周期性重试 + 支持手动触发。
4. 合并成功:`git worktree remove` + 删除任务分支,任务置 `done`。

### 7.4 冲突报告

`{archive_dir}/conflict-report.md`:冲突文件列表、双方提交摘要(git log/diff 提取)、worktree 路径、处理指引(在 worktree 解决后回软件点「重试合并」/ 或放弃)。v0.x 由模板生成;后续可选让 agent 二次加工给出解决建议。

### 7.5 非 git 项目

直接在项目目录执行,跳过 §7 全部流程,归档标注 `no_vcs`(无回滚能力,由用户自担)。

---

## 8. 存档与文档

### 8.1 目录结构

```
~/.dispatch/
├── config.json              # 全局配置
├── prompts/default.md       # 默认提示词模板(合并 harness 流程后生成,可编辑)
├── dispatch.db              # SQLite
├── worktrees/<project>/<task-id>/
├── archives/<project>/<date>-<task-id>/
│   ├── task.md              # 任务原文 + 元数据
│   ├── plan.md              # Phase 1 产出
│   ├── result.json          # Phase 2 产出
│   ├── output.log           # stdout/stderr 全量
│   └── conflict-report.md   # 如有
└── reports/<date>.md        # 日报
```

### 8.2 日报

- 每日定时(默认 21:00,可配)或手动生成。
- 内容:按项目聚合当日任务(状态 + result.summary + follow_up),纯模板拼接,不调用模型。summary 本就是 agent 写的,拼起来即可读。
- 后续增量:让某个 agent 读当日归档二次加工成「有观点的日报」;`follow_up` 汇总为「建议任务收件箱」,一键转正式任务。

### 8.3 清理策略

- done 任务的 worktree 立即清理;failed/conflict 的保留,超过 N 天(默认 14)提示用户批量清理。
- 归档永久保留(纯文本,体积可忽略)。

---

## 9. 调度器

- 主进程常驻(托盘),关窗不退出。
- 触发:每 30s 扫描 SQLite 中到点的 `scheduled` 任务;`immediate` 入库即入队。
- 并发控制:全局信号量(默认 2)+ 每项目合并锁。
- **崩溃恢复**:启动时把库中残留的 `running/merging` 任务置 failed(fail_reason=interrupted),对应 worktree 保留;`awaiting_merge` 恢复重试;`scheduled` 中已过期的按配置「补跑 / 跳过并标记」处理(默认补跑)。
- 孤儿进程:任务进程以进程组启动,kill 时清理整个进程树。

---

## 10. 配置

```jsonc
// ~/.dispatch/config.json(示意)
{
  "hotkey": "Alt+Space",
  "max_concurrency": 2,
  "task_timeout_min": 30,
  "daily_report_time": "21:00",
  "missed_task_policy": "run",          // run | skip
  "agents": {
    "claude-code": { "bin": "claude", "headless_args": ["-p"], "auto_approve_args": ["<构建时确认>"] },
    "codex":       { "bin": "codex",  "headless_args": ["exec"], "auto_approve_args": ["<构建时确认>"] },
    "dsh":         { "bin": "dsh", "headless_args": ["<确认>"], "ready_check_cmd": "<确认>", "start_cmd": "<确认>" },
    "kimi":        { "bin": "kimi", "headless_args": ["<确认>"] },
    "qwen":        { "bin": "qwen", "headless_args": ["<确认>"] }
  },
  "projects": {
    "default": { "path": "~/dispatch-default", "prepare_cmd": null, "base_branch": null /* null=执行时主工作区当前分支 */ }
  }
}
```

安全说明:无人值守执行必然使用各 CLI 的自动批准模式,agent 会在无人监督时修改文件与执行命令。缓解措施 = worktree 隔离 + 合并前冲突拦截 + 全量日志留档。用户应只把可信项目接入,`default` 项目目录不要指向敏感位置。

---

## 11. 技术栈

- Electron + React(复用 ZBuddy 工程经验),TypeScript。
- 主进程:globalShortcut、tray、node `child_process.spawn`(detached 进程组)、better-sqlite3、简单 interval 调度(不引重型 cron 库)。
- 渲染进程:捕获窗(无边框、置顶、失焦收起)+ 主窗(列表/详情/设置)。
- git 操作:直接 spawn `git`,不引 libgit2 绑定。

---

## 12. MVP 切分

**M1 — 闭环骨架(先跑通再铺开)**
快捷键捕获 → SQLite → `立即执行` → 仅 Claude Code adapter → worktree 创建 → 两阶段提示词(含 harness 流程合并)→ plan/result 协议校验 → 干净合并 + 冲突置 conflict(报告用最简模板)→ 归档落盘 → 详情页展示。

**M2 — 调度与全家桶**
定时触发、崩溃恢复、其余四个 adapter(dsh ensureReady)、系统通知、awaiting_merge 重试、失败重跑、prepare_cmd。

**M3 — 可见性**
日报生成、follow_up 收件箱、冲突报告增强、清理策略、设置页完善。

---

## 13. 开放问题(构建前需确认)

1. **docs/harness 任务流程文档**:需拿到原文并合并进默认提示词模板(§6 占位)。
2. 五个 CLI 的无头/自动批准参数、dsh 的 ready_check/start 命令:本机逐个 `--help` 确认后填入 §10 配置。
3. 捕获窗是否需要支持语音/粘贴图片?(v0.1 假设纯文本)
4. `default` 项目的实际目录指向哪里?
5. 定时任务错过触发(电脑关机)默认补跑,是否符合预期?
