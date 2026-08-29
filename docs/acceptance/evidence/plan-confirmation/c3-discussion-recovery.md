# c3 验收证据:讨论引擎与恢复

验收时间:2026-08-28(批次 3 审查)

## 实现落点

- `src/core/executor/plan-discussion.ts` `PlanDiscussionSession`:start 守卫(任务存在/status===awaiting_confirm/sessionId 非空/agent 非空/followUpTransport 非空);传输复用 SessionTransport 双实现;轮次串行闸门(busy 拒发);每轮追加 `<archiveDir>/discussion.log`;轮级失败只 close 广播不动任务状态;close 幂等不迁移状态。
- `src/core/archive/index.ts` OutputLog(archiveDir, fileName='output.log') 文件名参数;`read.ts` 归档追加 discussionLog。
- `src/shell/session-service.ts` 讨论会话表按 taskId 去重,open 幂等;disposeAll 收口只关传输不落 failed(与追写语义区分)。
- core `confirmPlan`(src/core/executor/index.ts):守卫 awaiting_confirm → 注入的 closeDiscussion 先关会话 → transition scheduled;shell 薄壳 enqueue。
- `src/core/task-edit.ts` abandonTask 守卫扩展 awaiting_confirm → failed(abandoned) + 清 worktree。
- 恢复:recovery.ts 不触碰 awaiting_confirm(批次 1 注释定论 + 批次 1 测试)。

## 验证命令与结果(审查者独立重跑)

- 同上批次统一命令:12 文件 111 测试全 passed(exit 0)。覆盖:三类守卫各自拒绝、串行闸门、轮级失败任务保持 awaiting_confirm、close 幂等、首轮模板渲染、discussion.log 读写、confirmPlan 先关会话再迁移次序、abandon 扩展清理 worktree、recovery 保留 awaiting_confirm。
