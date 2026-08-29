# L3 实机证据:真实 Claude CLI 两跑全链路

验收时间:2026-08-28

## 命令与结果(主 agent 直接执行)

```
RUN_REAL_CLAUDE=1 node scripts/run-vitest.mjs tests/real-claude.test.ts
✓ 真实 Claude Code 实机联调 > 立即执行 → 两阶段产物 → 自动合并回 base  132704ms
Test Files 1 passed (1)  Tests 1 passed (1)  exit 0
```

## 覆盖内容

真实 claude CLI(本机登录态)+ 真模板(resources/prompts)+ 真 git 仓库(tmpdir):
方案跑只产 plan.md 后任务停 awaiting_confirm(断言 paused.status)==='awaiting_confirm')→
模拟确认 transition 到 scheduled → 重入 runTask 执行跑 → 产物判定通过 → 自动合并回 base → done。

## 与 c5 的关系

本证据覆盖 c5 的「真实 agent 全链路」主干(L3 local_runtime),未覆盖系统通知弹出/点击与详情页
PlanConfirmPanel 的人工交互(Electron UI 层),该部分留作用户最短确认步骤(见 c5 记录)。
