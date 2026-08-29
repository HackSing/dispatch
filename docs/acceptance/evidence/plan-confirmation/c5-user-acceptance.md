# c5 用户验收证据:真实应用全链路(L5)

验收时间:2026-08-29(用户最终确认原话:「状态正常了,这个修复可以收尾了」)

## 用户真实任务全链路

| 任务 | 链路 | 结果 |
| --- | --- | --- |
| ed83d263「8 月份 A 股市场投资展望」 | 创建(立即执行)→ 方案跑停 awaiting_confirm → 讨论轮 1(「需要联网回答 A 股,不是美股」)主智能体回复并修订 plan.md → 确认放行 → 执行跑 → done | 通过 |
| c5a183d9「周末深圳有哪些 AI 的线下活动」 | 创建 → awaiting_confirm → 讨论轮 1、轮 2(「联网必须使用谷歌搜索,更改方案」)均正常回复并修订 → 任务保持 awaiting_confirm 可继续讨论/确认 | 通过 |

系统通知、待确认徽章、详情页方案确认区(确认按钮 + 讨论区 + ⌘Enter 发送)均由用户在真实窗口中实测。

## 验收期发现并已修复的两个缺陷(修复后均回归通过)

1. **详情页卸载误杀讨论轮(exit 143)**:PlanConfirmPanel 卸载 cleanup 曾调 plan-discuss-close。
   修复:卸载不再关会话(会话由主进程按 taskId 持有;仅确认/放弃/退出/轮级失败关闭)。
   回归:讨论轮进行中 Esc 收起详情,轮次照常跑完,重开详情经 discussion.log 回填续上。
2. **重开详情丢失「本轮进行中」busy 态**:busy 原为面板本地 state,重开后输入框误恢复可编辑。
   修复:`task:plan-discuss-open` 返回 `{ busy }`(session-service.ts:72、ipc.ts:141、PlanConfirmPanel.tsx:52)。
   回归(探针任务 e9695409,真实 GUI 自动化):发送讨论轮 → 输入框禁用、占位符「本轮进行中…」
   → Esc 收起 → 立即重开详情 → 输入框仍禁用、占位符仍为「本轮进行中…」→ 轮次正常结束(turns=2)。
   探针任务已删除,worktree 已清理,归档保留于 ~/.dispatch/archives/default/2026-08-29-e9695409/。

## 静态与构建复核(修复后)

- `npm run typecheck`(双 tsconfig)exit 0
- `node scripts/run-vitest.mjs tests/ipc-contract.test.ts tests/plan-discussion.test.ts` 8/8 passed
- `npm run build` 三产物全过;`assets-check --fast` 0 违规 0 警告
