> 状态：有效（实施中）
<!-- docs-harness:plan-document/v1 -->

# 交互批 V0.2:多项目清单、手动状态与会话接力(follow-up)

- 冻结合同：`sha256:b2271ca2faf5c433b947cd480adf2dbb1c2b3964f6798d6115c0148eb17c60a9`
- 关键符号：`sessionId`、`parentTaskId`、`task:follow-up`、`resume_headless_args`

## 背景

单项目全链路(捕获→执行→合并→归档,含 W1 工作流)已跑通。三个缺口:①清单页按项目分组已存在但零任务项目不渲染、done/failed 无限堆积无过滤;②状态机只有 todo→done(勾选),无反向边,纯人工 todo 勾错回不去;③所有 agent 运行都是匿名一次性会话,session id 未落库,任务跑完后无法在原会话继续。实测(claude 2.1.229):--session-id 可预生成;-p --resume 跨目录可用(worktree 删除不阻塞);resume 多轮 session id 稳定、历史累积。codex 有 exec resume 但不支持预指定 id(留待校准)。工作流模式 plan/review 是两次独立 session——「同一 session」假设仅单点模式成立。

## 目标

①清单页渲染全部项目(含空项目),项目分组可折叠带计数,任务按 进行中/已结束/全部 过滤;②状态机加 done→todo 边,复选框双向勾选;③session id 落库,done/failed 任务可在详情页追问:创建接力任务(继承 agent 与 session,--resume 续会话)走完整既有管线(worktree/合并/归档/通知),另提供「在终端打开会话」逃生舱按钮。

## 非目标

codex/kimi/qwen 的 resume 实参校准(只留配置面,UI 按能力隐藏);工作流 plan→review 同 session 化(W1 语义不动);内嵌终端(xterm.js/node-pty 原生依赖,否决);聊天式流式对话 UI;子智能体 session 捕获;B4 原有 follow_up 收件箱(result.json 字段聚合,与本批会话接力是两回事);Windows 终端打开。

## 成功标准

受影响模块测试全绿(state-machine/task-edit/config/adapter/executor/migration);实机门控:真实小仓库上 claude-code 任务跑完 done → 详情页追问 → 接力任务新 worktree 执行 → 合并 done,且接力轮 agent 能答出仅存在于首轮会话的信息(暗号法验证 session 连续);「在终端打开会话」拉起 Terminal 进入可交互 resume;空项目可见、过滤生效、done 任务可勾回 todo。

## 执行范围

src/shared/{state-machine,types,ipc}.ts;src/core/db/{migrations,task-store}.ts;src/core/config/index.ts;src/core/agents/{types,generic-cli-adapter}.ts;src/core/executor/{index,workflow}.ts;src/core/task-edit.ts;src/core/platform/{index,darwin}.ts;src/shell/ipc-handlers.ts;src/preload;src/renderer/src/{App.tsx,components/TaskDetail.tsx,components/TaskOps.tsx,stores/app-store.ts,lib/task-labels.ts};resources/prompts/follow-up.md;docs/agent-calibration.md;对应 tests/。

## 执行内容

分四批交付。B-a 契约层:migration v3 加 tasks.session_id/parent_task_id;Task 类型加 sessionId/parentTaskId;状态机 done:['todo'](注释同步);AgentConfig 加 session_args(string[],{SESSION_ID} 占位,空=不支持)、resume_headless_args(string[],resume 时整体替换 headless_args)、interactive_resume_cmd(string|null,终端逃生舱模板);claude-code 默认值:session_args=['--session-id','{SESSION_ID}'],resume_headless_args=['-p','--output-format','stream-json','--verbose','--resume','{SESSION_ID}'],interactive_resume_cmd='claude --resume {SESSION_ID}';其余 agent 三字段留空。AgentRunOptions 加 sessionId?/resume?;GenericCliAdapter 按 [session_args 渲染, ...headless_args 或 resume_headless_args 渲染, ...auto_approve_args] 组装 argv(纯配置模板渲染,零 agent 分支;session_args 前置保住 kimi「prompt flag 必须最后」约束);renderSessionArgs 小函数单点实现。B-b 执行层:executor 主 agent 每次 fresh run 前 crypto.randomUUID 预生成 session id 并 TaskStore 落库(单点一次;工作流 plan/review 各自生成,后写覆盖,任务留最后一次主 agent session);task-edit 加 followUpTask(仿 rerunFailedTask:仅 done/failed 且 sessionId 非空且 agent 配置支持 resume;新任务继承 projectId/agent/sessionId,subAgent 强制 null,parentTaskId=原任务,text=追问内容,immediate 入队);executor 识别 parentTaskId+sessionId → resume 模式:改用 resources/prompts/follow-up.md 模板(声明「此前改动已合并进 {BASE_BRANCH},你在全新 worktree,旧路径已失效;产物写 {OUT_DIR};若上一会话有只评不改约束,本轮解除」,复用既有 PROMPT_VARS,不加新变量),完成判定仅 judgeResultArtifact(接力可能不产码,不强制 plan.md),合并链路照旧;platform 加 openTerminal(cwd,cmd)(darwin: osascript tell Terminal do script),IPC 加 task:follow-up{id,text}→Task、task:open-session-terminal{id}→void、agent:capabilities→Record<AgentId,{followUp,terminal}>(主进程由 config 算出,渲染层不碰 config)。B-c 渲染层:App.tsx 渲染全部项目(空项目显提示)、分组折叠(折叠集持久化进 UiState.collapsedProjectIds)、进行中/已结束/全部 过滤 chips(默认进行中,带计数);复选框 todo/done 双向(task:toggle-todo 语义扩为 toggle);TaskDetail 对 done/failed+capability 显示追问输入框(发送→task:follow-up→跳新任务详情)与「在终端打开会话」;任务行加「接力」badge,详情显示 parent/child 链(store.tasks 内存过滤,不加查询通道)。B-d 收尾:实机门控、agent-calibration.md 补 resume 校准事实、acceptance 结项、plan settle。

## 验收方案

L1 单元/集成(ELECTRON_RUN_AS_NODE vitest):状态机新边与非法边;toggle 双向与守卫;followUpTask 继承/守卫(无 sessionId 拒、agent 不支持拒、subAgent 置空);config 新字段默认值与向后兼容(旧 config.json 载入不炸);adapter argv 组装 fresh/resume 两态与占位渲染;executor session 预生成落库、工作流 last-wins、接力走 follow-up 模板与 result-only 判定;migration v3。L2 实机门控(RUN_REAL_AGENTS=claude-code):暗号法两轮接力全链路 + 终端拉起。L3 用户确认:清单页多项目/过滤/双向勾选/追问一轮真实使用。

## 是否需要 Acceptance 资产闭环

```json
true
```

## Knowledge 影响

unchanged

## 约束

遵守 spec §5.2:GenericCliAdapter 内禁止 agent 特有分支,一切经配置模板;状态机改动必过 TaskStore.transition();已发布 migration 不改只追加;不引入新第三方依赖;kimi --prompt 必须保持最后 flag;提示词与代码流程同步(follow-up 模板明示新 worktree 与产物路径);用户已有 config.json 不含新字段时按 zod default 吸收,不改写用户文件。

## 风险与回滚

风险:①接力轮 session 记忆引用已删 worktree 旧路径,agent 可能困惑——follow-up 模板锚点缓解,实机门控专验;②工作流任务接力落在 review session,其提示词纪律为只评不改——模板显式解除,标注校准风险;③--session-id 撞已存在 id 会报错——每次 fresh run 新 UUID,不复用;④osascript 需自动化权限,首次弹系统授权——失败时错误上抛 UI 明示。回滚:migration v3 仅加列,旧版本可读;新 IPC 通道独立,逐批可回退;配置新字段缺省为空 = 功能整体隐藏。

## 用户与场景

用户是本机单人使用者,同时维护多个项目:少量任务交给 agent 自动执行,另有一批纯手写 todo 自己看;agent 任务跑完后常有增量诉求(改进产物、追问原因),希望在原会话上下文里继续而不是从零开新任务;偶尔需要接管到终端人肉操作。

## 入口与用户流程

①开主窗 → 看到全部项目分组(含空项目)与计数,默认「进行中」过滤,点 chips 切换;②纯 todo:勾选完成,勾错再点一下回 todo;③agent 任务 done/failed → 点开详情 → 追问框输入增量诉求 → 发送 → 自动创建接力任务并跳转其详情 → 观察执行/合并 → 详情可见 parent/child 链;④想人肉接管 → 详情点「在终端打开会话」→ Terminal 进入交互式 resume。

## 完整状态矩阵

任务行复选框:todo=可勾,done=可反勾,其余禁用;追问框:status∈{done,failed} ∧ sessionId≠null ∧ capability.followUp → 显示,发送中禁用防重复,失败显错误行;终端按钮:同前置 ∧ capability.terminal;接力任务本身:全生命周期与普通任务一致(状态机零新增边,done→todo 除外);过滤 chips:进行中={todo,scheduled,running,merging,awaiting_merge,conflict},已结束={done,failed};折叠:项目级布尔,持久化 UiState。

## 组件与交互

复用既有组件体系:TaskRow 加接力 badge 与双向复选框;TaskDetail 加追问区(textarea+发送)与终端按钮,操作走 window.dispatchApi.invoke,结果经 task:changed 广播回流 store(主进程唯一事实源纪律不变);App.tsx 项目分组段加折叠头与过滤 chips;TaskOps 不动;新 IPC 三通道进 @shared/ipc 契约,preload 自动派生。

## 视觉与响应式

沿用现有单栏卡片布局与 badge 样式;chips 与折叠头用现有 .btn/.badge 类微调,不引新样式体系;追问框 textarea 全宽,与 TaskEditForm 输入风格一致;窗口窄宽均为单栏,无新断点。

## 可访问性

复选框保留原生 input 语义与 title 提示;折叠头用 button 元素可键盘触发;追问 textarea 关联 label;错误信息沿用 .form-error 文本呈现(非仅颜色);chips 用 button+aria-pressed。

## 设计系统复用

无外部设计系统,复用项目自有类:badge/btn/task-card/form-error/project-group;不新增依赖,不引组件库;新样式仅在现有 CSS 文件追加少量类。

## 真实页面或桌面运行态验收

npm test 受影响模块全绿;RUN_REAL_AGENTS=claude-code 实机门控:真实小仓库任务 done 后追问「在 result.json 的 notes 里写出首轮暗号」,接力任务 done 且归档 notes 含暗号(session 连续铁证);终端按钮拉起 Terminal 且 claude 进入该会话;主窗手工核查:空项目可见、过滤计数正确、done 勾回 todo 后可再编辑。

<!-- docs-harness:plan-governance:start -->
## 资产治理

- 关联验收：`docs/acceptance/interaction-batch-v02.json`
- 需要 Acceptance：true
- Knowledge 影响：unchanged
<!-- docs-harness:plan-governance:end -->
