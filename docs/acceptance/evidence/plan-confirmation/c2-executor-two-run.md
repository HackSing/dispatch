# c2 验收证据:执行器两跑行为

验收时间:2026-08-28(批次 2+3 审查,批次 3 含工作流暂停补正)

## 实现落点

- 单点方案跑 `runPlanPhaseSingle`(src/core/executor/index.ts):default-plan.md → 判 plan.md → result.json 已存在则连跑兼容收尾;否则 transition running→awaiting_confirm(patch 带 archiveDir/worktreePath/branch,phase 冻结 plan)。
- 单点执行跑 `runExecPhase`(确认重入):default-exec.md → setPhase('implement') → judgeArtifacts → setPhase(null) → 合并/no_vcs 收尾。
- 恢复分支 `resumeAfterConfirm`:不重探 git、不重建归档(复用暂停时持久化字段,沿用原 baseBranch);runPhases 重入跳过 createTaskWorktree 与 prepare_cmd;plan.md 已被删 → 回退完整首跑并记日志。
- 工作流:runWorkflow 首跑 plan 判过后 transition awaiting_confirm(批次 3 补正,与单点对齐);重入标记 `phase==='plan' && plan.md 存在` → 跳过 runPlanPhase 直入 implement 循环。

## 验证命令与结果(审查者独立重跑)

- `npm run typecheck` → exit 0
- `node scripts/run-vitest.mjs tests/executor.test.ts tests/workflow-executor.test.ts tests/task-edit.test.ts tests/archive.test.ts tests/ipc-contract.test.ts tests/plan-discussion.test.ts tests/follow-up.test.ts tests/interrupt.test.ts tests/retry-merge.test.ts tests/recovery.test.ts tests/state-machine.test.ts tests/cleanup.test.ts` → exit 0,12 文件 111 测试全 passed。覆盖:单点首跑停 awaiting_confirm 字段持久化、确认重入跳过 plan 用 default-exec 至 done(no_vcs 与 git 合并)、连跑兼容分支、plan.md 删除回退、工作流首跑暂停+确认重入直入 implement、prepareRerun 清 phase 后完整两跑。
