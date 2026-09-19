> 状态：已实施-仅追溯（代码已是真源，2026-09-19 核对）
<!-- docs-harness:plan-document/v1 -->

# 合并闸精确化与会话/日志两缺陷修复

- 冻结合同：`sha256:7a11f43836dff271b321374075bd15d7b28f57162f9106be843bd85593192467`
- 关键符号：`inspectDirty`、`advanceBase`、`openPlanDiscussion`、`blockingFiles`

## 背景

任务 79a5c9c5 实录:主检出区仅有两个未跟踪插件目录(.v2c/.video_agent,与 incoming 提交零路径交集,ff 实际安全)却被判 base_dirty 挡停 10 分钟,fail_reason 只报笼统码,用户无从知晓挡路文件。实时日志缺陷:4 次真实运行一致显示 output.log 在 claude 进程退出瞬间才一次性落盘(claude 自身 transcript 证明事件分钟级早于落盘),6 组黑盒复刻(裸 CLI/node 父/Electron 父/--session-id/多轮工具/干净 worktree cwd)全部即时流式,黑盒变量已穷尽。会话双开竞态:React StrictMode 开发期双挂载 × SessionService.openPlanDiscussion 幂等检查与登记之间的 await 窗口,同参数拉起两个 claude --resume 进程,一个泄漏为孤儿(退出应用不回收)。

## 目标

批1:gitops 合并闸对「仅未跟踪文件且与 incoming diff 无路径交集」场景放行,tracked 改动仍拦截;awaiting_merge 的 failReason 携带挡路文件清单,UI 人话展示。批2:openPlanDiscussion 幂等改为 in-flight promise 共享消灭双开;清理孤儿进程;实时日志问题进入真实应用插桩定位(数据到达时刻二分:子进程侧 vs 应用内链路),按结论修复并以真实微型任务验证 output.log 运行期增长。

## 非目标

不改状态机与 DB schema;不动 conflict 报告格式;不修改 claude CLI 上游行为(若根因在上游,交付 Dispatch 侧缓解或结论报告);不新增 UI 界面(仅 failReason 文案);不引入新依赖。

## 成功标准

L2:新增 gitops 单测覆盖「未跟踪放行/未跟踪碰撞拦截(含目录坍缩形态)/tracked 仍拦」三态,既有 base_dirty 断言(tracked 场景)全部保持绿;并发双开单测证明只 start 一个会话。真实层:插桩定位到具体环节并修复,真实微型任务运行期 output.log 持续增长(非退出瞬间)。全量:typecheck+lint+聚焦测试绿,assets-check 无违规。

## 执行范围

src/core/gitops/index.ts(合并闸)、src/core/executor/index.ts(failReason 组装)、src/renderer/src/lib/task-labels.ts(人话映射)、src/shell/session-service.ts(幂等)、src/core/agents/generic-cli-adapter.ts(仅临时插桩,定位后拆除)、tests/(gitops 放行三态、并发双开、既有断言校准)。

## 执行内容

批1:gitops 新增 inspectDirty(dir) 用 status --porcelain 区分 tracked/untracked 条目(目录坍缩形态保留前缀匹配);advanceBase 在 tracked 空、untracked 非空时取 git diff --name-only <base-tip> <task-tip> 求交集,无交集放行 ff,有交集返回 reason=base_dirty + blockingFiles;executor 两处 awaiting_merge transition 的 failReason 组装统一为 helper(有 blockingFiles 时 base_dirty: <前5个文件,等N个>);task-labels 增加 base_dirty: 前缀人话分支。批2:session-service 以 discussionOpens: Map<taskId, Promise> 共享并发开启,finally 清理;kill 孤儿 79824;generic-cli-adapter stdout 'data' 与 onLog 两条路径加时间戳临时日志(electron-log 控制台),真实微型任务运行,按时间戳二分定位,修复后拆桩。

## 模块划分与接口骨架

src/core/gitops/index.ts — 职责:新增 inspectDirty(dir): Promise<{tracked: string[]; untracked: string[]}>(untracked 条目含目录坍缩形态,以 dir/ 结尾);MergeOutcome.awaiting_merge 分支扩展可选 blockingFiles?: string[];advanceBase 签名不变。src/core/executor/index.ts — 职责:awaitingMergeFailReason(outcome) 私有 helper 统一两处 transition 的 failReason 组装。src/renderer/src/lib/task-labels.ts — 职责:humanFailReason 新增 /^base_dirty: / 前缀分支渲染挡路文件。src/shell/session-service.ts — 职责:openPlanDiscussion 并发幂等(discussionOpens 私有表),对外签名不变。复用:statusPorcelain、gitRaw、LineBuffer 等既有设施,不平行新写。

## 验收方案

L2(vitest,临时 git 仓库工厂,沿用 tests/retry-merge.test.ts 既有设施):①未跟踪文件与 incoming 无交集 → ff_forward 且文件原样;②未跟踪文件路径与 incoming 新增文件碰撞(文件与目录坍缩两形态)→ awaiting_merge + failReason 含该文件;③tracked 改动 → base_dirty(既有断言保持);④session 并发双开只 start 一次。真实层:插桩定位修复后,真实微型任务(只回复ok)运行期 output.log 每 2s 采样持续增长。收尾:typecheck+lint+聚焦测试+assets-check。

## 是否需要 Acceptance 资产闭环

```json
false
```

## Knowledge 影响

unchanged

## 约束

不新增第三方依赖;不迁移 DB;插桩代码属临时代码,定位结论落定后必须拆除,不得随批残留;批1 不得改变 commitAllIfDirty(会话收尾)对脏的判定语义。

## 风险与回滚

交集判定若漏判(如大小写/unicode 归一),git 自身对「未跟踪文件会被覆盖」仍拒绝合并(GitError→failed),为最后防线但代价从待合并升级为失败,故交集判定必须带目录前缀形态的单测;回滚:各批改动文件独立,revert 对应文件即可,无数据迁移。

<!-- docs-harness:plan-governance:start -->
## 资产治理

- 关联验收：无
- 需要 Acceptance：false
- Knowledge 影响：unchanged
<!-- docs-harness:plan-governance:end -->
