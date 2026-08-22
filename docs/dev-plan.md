# Dispatch 技术研发方案 v0.1（分批实现）

> 依据 [dispatch-spec.md](dispatch-spec.md) v0.1 制定。已确认决策:**macOS 先行、Windows 随后**;技术栈 **Electron + React + TypeScript**;harness 任务流程以 `/Users/aiware/projects/docs-harness`(v2.9.1)的 AGENTS.md 工作流规则为合并来源。
>
> 状态:有效(现行方案)。完整业务流程图见 [flows.md](flows.md)(端到端时序、状态机、执行/合并/调度恢复流程,与 main 实现逐边核对)。

---

## 0. 决策记录(本方案的前提)

| 决策点 | 结论 | 依据 |
|---|---|---|
| 双端定义 | macOS + Windows 桌面双平台;macOS 先交付,Windows 作为独立批次(B5)跟进 | 用户确认;spec 明确排除移动端 |
| 框架 | Electron + React + TS(electron-vite 脚手架 + electron-builder 打包) | 行业最通用的跨平台桌面栈,复用 ZBuddy 经验 |
| harness 来源 | docs-harness 项目的 AGENTS.md「工作流规则 + 编码质量规范 + 收尾证据」章节,改写为无人值守版并入提示词模板 | 用户指定路径;spec §6 占位由此填充 |
| 架构原则 | 核心逻辑(调度/执行/git/归档)写成**与 Electron 解耦的纯 Node 模块**,Electron 只做壳与 UI | 可 headless 测试、可换壳,是桌面应用的通用分层实践 |
| 跨平台预埋 | 从 B0 起所有平台差异(快捷键默认值、进程 kill、二进制探测)收敛到 `platform/` 抽象层,B5 只补 Windows 实现 | 避免 Windows 批次变成全仓返工 |

spec §13 其余开放问题已定,可随时改配置:错过触发默认补跑(`missed_task_policy: run`);捕获窗 v0.1 纯文本;`default` 项目目录为 **`~/Dispatch/default`**,首启自动创建并 `git init` + 首次提交——default 项目接的是最无人盯守的杂项任务,必须走 worktree 隔离而非 `no_vcs` 旁路;不放 `~/Documents`/`~/Desktop`(iCloud 同步与 git 仓库有已知冲突),路径可在设置页修改;日报生成后发系统通知,`daily_report_notify` 默认开、设置页可关。

**需要提前指出的两个 spec 修正:**

1. **`Alt+Space` 不能作为跨平台默认快捷键**。Windows 上它是系统窗口菜单;macOS 上 Option+Space 会输入不换行空格,全局拦截会影响所有输入场景。方案:macOS 默认 `Cmd+Shift+Space`,Windows 默认 `Ctrl+Shift+Space`,均可配置,注册失败(被占用)时在托盘提示并引导改键。
2. **spec §7.3 的 `git branch -f <base> task/<id>` 有一个 git 硬限制**:被任何 worktree 检出的分支不能用 `branch -f` 移动。实现改用 `git update-ref refs/heads/<base> <task-commit>` 并先枚举 `git worktree list` 确认 base 未在别处检出;在主工作区检出且干净时走 `merge --ff-only`(与 spec 一致),检出且脏时置 `awaiting_merge`(与 spec 一致)。

---

## 1. 总体架构

### 1.1 进程模型(Electron 标准三层)

```
┌─────────────────────────────────────────────────────────┐
│ Main Process(常驻,托盘)                                │
│  ┌───────────────────────────────────────────────────┐  │
│  │ core/(纯 Node,零 Electron 依赖,可独立单测)      │  │
│  │  db/        SQLite 访问 + 迁移                     │  │
│  │  scheduler/ 扫描、并发信号量、合并锁、崩溃恢复      │  │
│  │  executor/  Phase0/1/2 编排、超时、完成判定         │  │
│  │  agents/    AgentAdapter 接口 + 5 适配器 + 检测     │  │
│  │  gitops/    worktree 创建/合并/冲突报告(spawn git)│  │
│  │  archive/   归档目录、task.md、日报生成             │  │
│  │  config/    config.json 读写 + zod 校验             │  │
│  │  platform/  快捷键默认值、进程树 kill、二进制探测    │  │
│  └───────────────────────────────────────────────────┘  │
│  shell/  Electron 装配:tray、globalShortcut、窗口管理、 │
│          Notification、IPC handler 注册                  │
├───────────── preload(contextBridge,类型化 API)───────┤
│ Renderer(React + Vite)                                 │
│  捕获窗(无边框/置顶/失焦收起) 主窗(列表/详情/设置)  │
└─────────────────────────────────────────────────────────┘
```

安全基线(Electron 官方推荐,全程不放松):`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`,渲染进程只能通过 preload 暴露的类型化 API 与主进程通信。

### 1.2 技术选型(全部为行业通用件)

| 用途 | 选型 | 说明 |
|---|---|---|
| 脚手架/构建 | electron-vite | 主/preload/渲染三端统一 Vite 构建,当前社区标准 |
| 打包分发 | electron-builder | macOS dmg/zip;B5 加 NSIS |
| 数据库 | better-sqlite3(WAL 模式) | 同步 API,主进程单写者,免去异步竞态;迁移用 `PRAGMA user_version` + 顺序 SQL 文件 |
| 配置校验 | zod | config.json、result.json、IPC 载荷三处共用 schema |
| 日志 | electron-log | 应用日志;任务 stdout/stderr 另行全量写归档 |
| 渲染态管理 | zustand + IPC 事件推送 | 主进程是唯一事实源,渲染层只做订阅镜像;不引 Redux |
| Markdown 渲染 | react-markdown | plan.md / 冲突报告 / 日报详情页展示 |
| 单测 | vitest | core/ 全部可 headless 测 |
| 端到端 | Playwright for Electron | B2 起冒烟用例 |
| 代码质量 | ESLint + Prettier + tsc --noEmit,CI 三连 | |

不引入的东西及理由:重型 cron 库(30s interval 足够,spec §9 明示)、libgit2 绑定(spec §11 明示 spawn git)、ORM(表就 3 张,SQL 直写更透明)。

### 1.3 仓库结构

```
dispatch/
├── src/
│   ├── core/            # 纯 Node:db/ scheduler/ executor/ agents/ gitops/ archive/ config/ platform/
│   ├── shell/           # Electron 主进程装配 + IPC handlers
│   ├── preload/
│   ├── renderer/        # windows/capture  windows/main  components/  stores/
│   └── shared/          # IPC 契约类型、Task/Project 类型、状态机常量(主渲共用唯一来源)
├── resources/prompts/default.md   # 提示词模板源文件,首启拷贝到 ~/.dispatch/prompts/
├── tests/               # vitest 单测 + fixtures(临时 git 仓库工厂、mock agent)
├── e2e/                 # Playwright
└── docs/
```

### 1.4 关键机制设计

**类型化 IPC**:`shared/ipc.ts` 用一张接口表声明全部 channel 的请求/响应/事件类型,preload 与主进程 handler 都从它派生,杜绝字符串 channel 漂移。渲染层数据流只有两种:`invoke`(查询/命令)与主进程广播的 `task-changed` 事件(渲染层据此刷新,不做本地状态推演)。

**状态机集中化**:`shared/state-machine.ts` 定义唯一的合法迁移表(spec §4.2),db 层写状态前强制校验迁移合法性,非法迁移直接抛错。所有状态变更集中在一个 `TaskStore.transition()` 入口,同时负责发 IPC 事件与系统通知,避免状态散写。

**进程树管理**:`spawn(bin, args, { detached: true })` 起进程组;超时/取消时 macOS 用 `process.kill(-pid, 'SIGTERM')` → 5s 后 `SIGKILL`;Windows 实现(B5)`taskkill /PID <pid> /T /F`。封装在 `platform/process.ts`,executor 不感知平台。

**Adapter 全配置驱动**:五个 adapter 共用一个 `GenericCliAdapter` 实现,行为差异全部来自 config(`bin`、`headless_args`、`auto_approve_args`、`prompt_via: arg|stdin`、`ready_check_cmd`、`start_cmd`),dsh 的 `ensureReady()` 即「跑 ready_check_cmd,失败则跑 start_cmd 后轮询」。代码里没有任何 agent 特有分支——CLI 参数变更只改 `~/.dispatch/config.json`(spec §5.2 原则)。

**Mock adapter(测试专用,不进发行版配置)**:一个本地脚本型 adapter,按参数决定行为:正常写 plan.md+result.json、只写一半、写非法 JSON、超时挂死、非零退出。executor/gitops/归档的集成测试全部用它驱动,不烧真实 agent token,也不依赖本机装了哪些 CLI。这是整个测试策略的支点。

---

## 2. 数据模型

```sql
-- migrations/001_init.sql
CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,          -- nanoid
  created_at    TEXT NOT NULL,             -- ISO8601,下同
  text          TEXT NOT NULL,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  agent         TEXT,                      -- 可空(todo)
  trigger_type  TEXT NOT NULL,             -- immediate | at | none
  trigger_at    TEXT,                      -- trigger_type=at 时有效
  status        TEXT NOT NULL,             -- spec §4.2 八状态
  base_branch   TEXT,
  branch        TEXT,
  worktree_path TEXT,
  archive_dir   TEXT,
  fail_reason   TEXT,
  scheduled_at  TEXT, started_at TEXT, finished_at TEXT, merged_at TEXT
);
CREATE INDEX idx_tasks_status_trigger ON tasks(status, trigger_at);

CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
  prepare_cmd TEXT, base_branch TEXT,      -- base_branch NULL = 执行时取主工作区当前分支
  created_at TEXT NOT NULL
);

CREATE TABLE agent_detections (            -- 检测结果缓存(spec §5.3)
  agent_id TEXT PRIMARY KEY, ok INTEGER NOT NULL,
  version TEXT, fail_reason TEXT, checked_at TEXT NOT NULL
);
```

项目列表存 SQLite 而非 config.json(spec §10 示意里在 config):项目是用户数据且被任务外键引用,放库里保证一致性;config.json 只放行为配置。`result.json`、`plan.md` 不入库,库里只存 `archive_dir` 指针,详情页按需读盘——归档是真源,库是索引。

---

## 3. 提示词模板:harness 合并方案

模板 `resources/prompts/default.md`,首启拷贝到 `~/.dispatch/prompts/default.md`,用户可改;执行时做变量替换:`{TASK_TEXT}` `{OUT_DIR}` `{PROJECT_PATH}` `{BASE_BRANCH}`。

结构 = spec §6 两阶段协议(骨架)+ harness AGENTS.md 规则(血肉),改写要点:

1. **两阶段协议为主干**(spec §6.1/6.2 原文):先探索仓库理解意图 → 写 `{OUT_DIR}/plan.md`(含假设清单)→ 执行 → 偏离先补「变更记录」→ 结束前写 `{OUT_DIR}/result.json`。强调两个产物写归档目录绝对路径,不写入仓库。
2. **注入 harness 工作流规则的无人值守改写版**。原规则中所有「先向用户确认」分支在全自动场景不可用,统一改写为:「选择最合理假设,把假设与被放弃的备选方案记入 plan.md,并在 result.json 的 notes 中提示需人工复核」。保留:验收先行(动手前把验收条件转写为可执行验证)、根因优先、回归必跑(受影响模块级,非全仓)、聚焦优先按风险扩展的测试范围纪律。
3. **注入 harness 编码质量规范精选**:先复用后新写、重复即抽象、分层隔离、错误不许吞、不擅自加依赖(无人值守下收紧为:需要新依赖时任务按 partial 收尾并写入 follow_up,不得自行引入)、防御代码准入(无证据的兜底只写报告不写代码)。
4. **注入 harness 收尾纪律**:「没有证据不宣称完成」→ result.json 的 `status=success` 必须以实际执行过的验证命令与退出结果为据(写入 summary/notes);验证跑不了(缺环境)最高只能报 `partial`。这条直接决定日报可信度,是 harness 合并里价值最高的一条。
5. **不注入**的部分:harness 的 Plan/Knowledge/Acceptance/ADR 资产 CLI 生命周期(那是 docs-harness 安装到项目后由 agent 自主使用的能力,Dispatch 不做第二套工单系统——恰好符合 harness 自己「不建立第二套任务审批」的原则)。若目标项目本身装了 docs-harness,agent 会读到项目内 AGENTS.md 自然启用,两者不冲突。

---

## 4. 分批计划

批次划分原则(harness「分批交付」规则同样适用于本项目自身):每批可独立验收、验收过再进下一批;先纵向闭环(B2),再横向铺开(B3/B4);平台移植独立成批(B5)。

### B0 — 工程骨架(约 3~4 天)

**范围**:electron-vite 脚手架(TS strict);main/preload/renderer 三端与安全基线;类型化 IPC 框架;better-sqlite3 接入 + 迁移框架 + 三张表;config 模块(zod 校验、缺省生成 `~/.dispatch/`);electron-log;托盘 + 关窗不退出 + 空主窗;`platform/` 抽象层骨架;CI(lint + tsc + vitest)。

**验收**:应用启动进托盘;`~/.dispatch/{config.json,dispatch.db}` 正确生成;迁移幂等(重复启动 user_version 不变);db/config 单测绿;CI 绿。

### B1 — 捕获与任务库(约 4~5 天)

**范围**:globalShortcut 注册(含冲突失败提示与改键);捕获窗(无边框、置顶、失焦收起、Esc 取消、回车提交、多行输入、三选择器、记忆上次选择);项目管理(新建选文件夹/编辑/删除,含捕获窗内快速新建);agent 检测框架(`which` + `--version` 两级,结果入 `agent_detections`,启动时 + 设置页手动刷新;先只实测 claude,其余四个走同一框架待 B3 校准参数);主窗任务列表(按项目分组、状态徽标、触发时间);todo 生命周期(勾选完成、编辑升级为可执行任务);任务编辑/取消。

**验收**:快捷键 <300ms 唤起;提交即入库且主窗实时刷新;未检测到的 agent 置灰并标注原因;重启后记忆项保留。此批结束产品已可当纯 todo 工具用。

### B2 — 执行闭环(约 7~10 天,对应 spec M1,风险最高)

**范围**:
- 调度骨架:`immediate` 入队即执行;全局并发信号量(默认 2)。
- Phase 0:归档目录创建(`archives/<project>/<date>-<task-id>/`,写 task.md);gitops 创建 worktree(`~/.dispatch/worktrees/…`,base 取执行时刻最新);非 git 项目旁路(`no_vcs`);`prepare_cmd` 执行(失败→failed)。
- 提示词模板落地(§3 的 harness 合并版)+ 变量替换。
- Claude Code adapter 实机打通(`claude -p` + 本机 `--help` 确认的自动批准参数写入默认 config);stdout/stderr 流式落 `output.log` 并推详情页尾部。
- 完成判定:退出码 + plan.md 存在 + result.json 可解析且 status≠failed,fail_reason 精确到缺哪环(spec §6.3)。
- 超时:默认 30 分钟,kill 进程树,worktree 保留。
- 合并:每项目合并锁;worktree 内 merge base → 冲突则 abort 置 `conflict` + 模板版冲突报告;干净则按 §0 修正后的三分支策略推进 base;成功清 worktree 删分支置 `done`。
- 详情页:任务原文 / plan.md 渲染 / result.json 渲染 / 日志尾部 / 冲突报告。
- Mock adapter + 测试设施:临时 git 仓库工厂,集成测试覆盖「成功合并 / 冲突 / 缺 result / 非法 JSON / 超时 / prepare 失败 / 脏主工作区 / 非 git 项目」八条路径。

**验收**:L2——上述八条路径集成测试全绿;L3——真实小仓库 + 真实 Claude Code 跑通「捕获→立即执行→自动合并→详情页看到 plan/result/日志」全链路,并实测一次人为制造的冲突进入 `conflict` 且报告可读。**此批是产品成立与否的证明点,验收过才继续铺开。**

### B3 — 调度与多 agent(约 5~7 天,对应 spec M2)

**范围**:定时触发(30s 扫描,含时钟回拨/睡眠唤醒容错);崩溃恢复(启动时 `running/merging`→failed(interrupted)、`awaiting_merge` 恢复重试、过期 `scheduled` 按 `missed_task_policy` 处理);`awaiting_merge` 周期重试 + 手动触发;失败重跑(复制入队);系统通知四类事件(done/failed/conflict/awaiting_merge,点击跳详情);其余四个 adapter 实机校准——逐个 `--help` 确认无头/自动批准参数填入默认 config,dsh 的 `ensureReady()`(ready_check_cmd 失败→start_cmd→轮询就绪,轮询超时→failed);检测覆盖全部五个。

**验收**:L2——调度器时间逻辑用假时钟单测(到点触发、错过补跑/跳过、并发上限);L3——定时任务实机触发;执行中强杀应用重启后任务正确置 failed 且可一键重跑;五个 agent 各实跑一个最小任务(参数校准以实测为准,跑不通的在 config 标注并在 UI 置灰说明,不阻塞批次)。

### B4 — 可见性(约 4~5 天,对应 spec M3)

**范围**:日报(每日定时默认 21:00 + 手动;按项目聚合状态 + result.summary + follow_up,纯模板拼接落 `reports/<date>.md`,主窗可浏览;生成后发系统通知,点击打开,`daily_report_notify` 可关);follow_up 收件箱(扫描归档聚合,一键转正式任务);冲突报告增强(冲突文件列表、双方提交摘要、处理指引);清理策略(done 即清 worktree 已在 B2,此处补 failed/conflict 超 14 天批量清理提示);设置页完善(快捷键、并发、超时、日报时间、错过策略、agent 参数、项目管理、检测刷新)。

**验收**:L3——造一天多任务多项目数据,日报分组正确、follow_up 转任务可执行;设置项改动即时生效且重启保留。**至此 macOS 版 v0.1 功能完整,进入自用 dogfooding。**

### B5 — Windows 适配(约 5~8 天,依赖 B2~B4 稳定)

**范围**:`platform/` 层 Windows 实现(进程树 kill=taskkill、二进制探测 `where` + `.cmd/.exe` 解析、默认快捷键 `Ctrl+Shift+Space`);路径处理审计(全仓强制 `path.join`、worktree/归档路径含空格用户名实测);git worktree 全流程 Windows 实测(重点:进程未死时 `worktree remove` 的文件锁问题,失败进重试队列);五个 agent CLI 的 Windows 可用性逐个实测(仅 WSL 可用的在检测中如实标注「需 WSL,暂不支持」,不做 WSL 桥接——那是 v0.2 话题);托盘/通知/开机自启 Windows 行为校验;electron-builder NSIS 打包;CI 加 Windows job(core 单测 + 冒烟)。

**验收**:L2——core 单测在 Windows CI 全绿;L3——Windows 实机跑通 B2 全链路;L4——NSIS 安装包装出的应用可用。

### 批后事项(不阻塞 v0.1)

代码签名/公证(macOS notarization、Windows 签名)、electron-updater 自动更新、agent 加工版日报、冲突报告 agent 二次加工、语音/图片捕获。

---

## 5. 测试策略

| 层 | 对象 | 手段 |
|---|---|---|
| L1 | 全仓 | tsc strict + ESLint,CI 强制 |
| L2 | core/ 全模块 | vitest;调度器用假时钟;gitops/executor 用临时 git 仓库工厂 + mock adapter,不依赖真实 CLI 与网络 |
| L3 | 全链路 | Playwright 冒烟(启动、捕获窗、列表);真实 agent 实跑作为各批人工验收项 |
| L4 | 安装产物 | electron-builder 产物实装验证(B4 末 macOS、B5 末 Windows) |

原则沿用 harness:聚焦优先、按风险扩展;真实 agent 调用只在批次验收时人工执行,日常回归全走 mock,保证测试免费且确定。

## 6. 风险清单(按影响排序)

1. **合并策略的 git 边角**(B2):base 被多 worktree 检出、submodule、浅克隆、merge 期间用户操作仓库。缓解:合并全程持项目锁、每步 git 命令失败即置 conflict/failed 并留全量输出,宁可误停不可误合;§0 修正 2 已消掉最大的一个坑。
2. **各 CLI 无头参数漂移**(B2/B3):参数全配置化已缓解;每个 adapter 的默认 config 里记录「校准日期 + CLI 版本」,检测到版本变化时 UI 提示重校准。
3. **无人值守 + 自动批准的安全面**(贯穿):spec §10 已声明风险自担;工程侧兜底 = worktree 隔离 + 非 git 项目在 UI 明示「无回滚」+ 全量日志。不做沙箱(明确非目标,避免范围膨胀)。
4. **Electron 全局快捷键被占用**(B1):注册失败显式提示改键,不静默失效。
5. **Windows 文件锁与 WSL 生态**(B5):已在批内列为实测项;WSL 桥接明确推迟。

## 7. 前提确认记录(2026-08-22)

1. 本机 Claude Code 可用,B2 实机校准无阻塞;B3 前需确认其余四个 CLI 可用。
2. `default` 项目目录:`~/Dispatch/default`,首启自动创建并 `git init`(见 §0)。
3. 日报生成后发系统通知,`daily_report_notify` 默认开、可在设置页关闭。

全部前置已清,可从 B0 开工。
