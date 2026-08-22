# Dispatch 业务流程图

> 状态:有效(现行事实,与 main 分支实现一致,2026-08-22 核对)
> 依据实现:`src/shared/state-machine.ts`、`src/core/executor/`、`src/core/gitops/`、`src/core/scheduler/`、`src/shell/`。改流程必须同步改本文档。

## 1. 端到端全景:一条任务的一生

关键分工:**实线框 = Dispatch 确定性代码(零模型调用);双线框 = agent CLI 内的模型行为**。「任务变方案」发生在 agent CLI 的 Phase 1,不是 Dispatch。

```mermaid
sequenceDiagram
    actor U as 用户
    participant C as 捕获窗
    participant DB as SQLite
    participant S as 调度器<br/>(30s tick)
    participant E as Executor<br/>(Dispatch)
    participant A as Agent CLI<br/>(模型)
    participant G as Git 仓库
    participant N as 系统通知

    U->>C: 快捷键唤起,输入任务 + 时间/智能体/项目
    C->>DB: task 入库(scheduled / todo)
    Note over DB: immediate 入库即入队,<br/>at 等调度器扫描
    S->>DB: 扫描到期任务(去重)
    S->>E: enqueue(taskId)
    E->>DB: scheduled → running
    E->>G: 创建 worktree(task/<id8>-<slug>)<br/>非 git 项目跳过,记 no_vcs
    E->>E: prepare_cmd、ensureReady、<br/>模板渲染(纯字符串替换)
    E->>A: spawn CLI(detached 进程组,完整工单)
    activate A
    Note over A: Phase 1:探索仓库→推断意图<br/>→假设清单→写 plan.md(归档目录)
    Note over A: Phase 2:按方案执行→改代码<br/>→跑验证→git 提交→写 result.json
    A-->>E: 进程退出(stdout 经过滤器流式落 output.log)
    deactivate A
    E->>E: 完成判定:退出码 + plan.md 存在<br/>+ result.json 可解析且 status≠failed
    alt 判定失败
        E->>DB: → failed(fail_reason 精确到缺哪环)
    else git 项目
        E->>G: mergeFlow(见 §4)
        E->>DB: → done / conflict / awaiting_merge
    else no_vcs
        E->>DB: → done
    end
    E->>N: done/failed/conflict/awaiting_merge 四类事件通知
    N-->>U: 点击通知 → 主窗打开任务详情
```

## 2. 任务状态机

与 `src/shared/state-machine.ts` 的 TRANSITIONS 逐边一致;所有状态写入经 `TaskStore.transition()` 校验,非法迁移直接抛错。

```mermaid
stateDiagram-v2
    [*] --> todo: 创建(trigger=none)
    [*] --> scheduled: 创建(immediate/at)
    todo --> scheduled: 编辑补充时间+智能体
    todo --> done: 手动勾选完成
    scheduled --> todo: 取消执行
    scheduled --> running: 到点触发 / 立即执行
    running --> merging: 执行成功(git 项目)
    running --> done: 执行成功(no_vcs)
    running --> failed: 超时/缺产物/异常退出/interrupted
    merging --> done: 干净合并,worktree 清理
    merging --> awaiting_merge: base 脏 / 被其他工作区检出
    merging --> conflict: 合并冲突,出报告,worktree 保留
    merging --> failed: git 异常 / interrupted
    awaiting_merge --> merging: 60s 自动重试 / 手动重试
    awaiting_merge --> failed: 放弃(abandoned)
    conflict --> merging: 用户解决后手动重试
    conflict --> failed: 放弃(abandoned)
    failed --> [*]: 终态(可「重跑」=复制新任务)
    done --> [*]: 终态
```

## 3. 单任务执行流程(runTask)

```mermaid
flowchart TD
    A["取任务,校验 status=scheduled"] --> B["→ running<br/>记 startedAt、baseBranch"]
    B --> C["创建归档目录<br/>写 task.md,开 output.log"]
    C --> D{git 项目?}
    D -- 否 --> E["cwd = 项目目录,记 no_vcs"]
    D -- 是 --> F["从 base 最新提交建 worktree<br/>分支 task/&lt;id8&gt;-&lt;slug&gt;"]
    E --> G{"prepare_cmd 配置了?"}
    F --> G
    G -- "执行失败" --> X1["failed: prepare_failed"]
    G -- "成功/未配置" --> H["adapter.ensureReady()<br/>(dsh 类:ready_check→start→轮询)"]
    H --> I["加载模板 + 四变量替换<br/>(纯字符串,无模型)"]
    I --> J["spawn agent CLI<br/>detached 进程组,超时=AbortSignal"]
    J -- "超时 → killTree 全进程组" --> X2["failed: timeout<br/>worktree 保留"]
    J --> K{"完成判定(全过才算成功)"}
    K -- "退出码≠0" --> X3["failed: exit_&lt;code&gt;"]
    K -- "无 plan.md" --> X4["failed: no_plan"]
    K -- "无/坏 result.json" --> X5["failed: no_result / bad_result"]
    K -- "status=failed" --> X6["failed: result_failed"]
    K -- 通过 --> L{git 项目?}
    L -- 否 --> M["→ done"]
    L -- 是 --> N["mergeFlow(§4,项目合并锁串行)"]
    N -- 干净 --> O["→ done,removeWorktree+删分支"]
    N -- 冲突 --> P["→ conflict,生成 conflict-report.md<br/>worktree/分支保留"]
    N -- "base 不可推进" --> Q["→ awaiting_merge<br/>fail_reason 记阻塞原因"]
```

## 4. 合并流程(mergeFlow,spec §7.3 + dev-plan §0 修正 2)

全程在 task worktree 内与 ref 层操作,**绝不改写用户主工作区内容**。

```mermaid
flowchart TD
    A[取项目合并锁] --> B["task worktree 内<br/>git merge &lt;base&gt;(把 base 合进任务分支)"]
    B -- 冲突 --> C["git merge --abort<br/>→ conflict + 报告"]
    B -- 干净 --> D{"base 分支被谁检出?<br/>(git worktree list --porcelain)"}
    D -- 未被任何工作区检出 --> E["update-ref 推进 base<br/>(git 禁止 branch -f 移动已检出分支)"]
    D -- "主工作区检出且干净" --> F["主工作区 git merge --ff-only"]
    D -- "主工作区检出且脏" --> G["→ awaiting_merge(base_dirty)<br/>不碰用户改动"]
    D -- "其他 worktree 检出" --> H["→ awaiting_merge<br/>(base_checked_out_elsewhere)"]
    E --> I["→ done:removeWorktree + 删任务分支"]
    F --> I
    G --> J["调度器每 60s 自动重试<br/>用户也可手动「重试合并」或「放弃」"]
    H --> J
```

## 5. 调度与崩溃恢复

```mermaid
flowchart TD
    subgraph 启动时 recoverOnStartup
        R1["running/merging 残留<br/>→ failed(interrupted)"] --> R2["扫 worktrees/&lt;project&gt;/&lt;task-id&gt;/<br/>孤儿目录,回填 db 三字段<br/>(仅补 NULL,拒绝覆盖)"]
        R2 --> R3{"过期定时任务<br/>missed_task_policy?"}
        R3 -- run --> R4[入队补跑]
        R3 -- skip --> R5["→ failed(missed_skipped)"]
    end
    R4 --> T
    R5 --> T
    subgraph 常驻调度 每30s tick
        T["扫 scheduled:immediate 或 trigger_at≤now"] --> T1["in-flight 去重后 enqueue<br/>(全局信号量,默认并发 2)"]
        T --> T2["扫 awaiting_merge<br/>每任务 60s 节流 → retryMerge"]
    end
```

## 6. 用户干预操作流

```mermaid
flowchart LR
    F[failed] -- 重跑 --> F1["复制 text/项目/智能体<br/>为新任务 immediate 入队<br/>(原任务保留追溯)"]
    C[conflict] -- "在 worktree 手动解决<br/>并提交后点「重试合并」" --> M[merging]
    C -- 放弃 --> AB["failed(abandoned)<br/>worktree 保留待清理策略回收"]
    W[awaiting_merge] -- "清理主工作区后<br/>自动/手动重试" --> M
    W -- 放弃 --> AB
    M -- 见 §4 --> D[done / conflict / awaiting_merge]
```

## 已知边角(与图的偏差点)

1. `missed_task_policy=skip` 实际走 scheduled→running→failed 两步(状态机无直达边),UI 会闪一下「执行中」。
2. conflict worktree 内手动 merge 未提交(MERGE_HEAD 残留)时点重试 → failed(merge_retry),只能重跑;数据不丢。
3. 睡眠唤醒依赖 setInterval 自然补扫,无 powerMonitor 特判;关机错过的任务走 §5 的 missed 策略。
