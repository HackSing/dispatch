# CODEMAP：代码能力索引

动手写代码前先查本索引定位可复用模块；新增代码文件或公开接口变化时同步更新条目。
每行一个模块，格式如下（登记时去掉行首的"示例："）：

示例：- `src/example/module.py` — 职责：一句话说明；公开接口：`main_function`、`ExampleClass`

Structure 检查会校验登记路径存在、公开接口符号存活，并提醒未登记的新增代码文件；
测试文件不必登记。

## 模块条目

- `src/core/executor/plan-discussion.ts` — 职责：awaiting_confirm 任务执行前与主智能体的多轮方案讨论会话引擎（复用会话传输修订归档 plan.md，不建接力任务/worktree/合并链路，全程不迁移任务状态）；公开接口：`PlanDiscussionSession`
- `src/renderer/src/components/PlanConfirmPanel.tsx` — 职责：awaiting_confirm 任务详情内嵌的方案确认区（方案展示 + 多轮讨论区 + 「确认，开始执行」/放弃入口，能力缺失时降级为只读方案）；公开接口：`PlanConfirmPanel`
- `src/renderer/src/components/ConfirmDialog.tsx` — 职责：应用内确认对话框（替代 Electron sandbox 下同步返回 false 的 window.confirm，承载删除/放弃等危险操作确认）；公开接口：`useConfirmDialog`
