> 状态：已实施-仅追溯（代码已是真源，2026-08-23 核对）
<!-- docs-harness:plan-document/v1 -->

# 工单档位路由:default.md 移植 docs harness 触发条件分档

- 冻结合同：`sha256:730a7a3e1485b951c8fcb388b3298e0910b8f40c7c4eedf08e6ed9a575069b87`
- 关键符号：`simple_direct_answer`、`effect_requires_work`、`prompt-real-template`、`judgeArtifacts`

## 背景

现行 default.md 对所有任务施加同一套全纪律工单协议:纯问答任务(如天气查询)也要多源交叉核验+五小节 plan.md,实测端到端 99s(boot ~15s + agent 71s + 收尾 13s),其中核验矩阵约占 50s。docs harness 的 plan select(scripts/harness.py:1071-1082)提供了成熟路由形状:显式优先→触发条件升档→默认最轻,每个判定带 reason 落盘。模板是全 agent 共用的(配置驱动、零 agent 分支),judgeArtifacts 的产物硬门槛(plan.md 存在 + result.json 可解析)不变。

## 目标

任务按「是否需要改动文件」一票分为 answer/work 两档:answer 档免交叉核验、plan.md 薄骨架,预期问答类任务端到端 <45s;work 档纪律不减;路由判定与 reason 写入 result.json notes 首行可审计;dispatch 代码零改动。

## 非目标

不做 brief 中间档;不做显式档位 UI 与 task.route 字段(B2,视 B1 误判率再议);不改 workflow 模板(wf-* 即显式重档);不解决 dsh 15s 冷启动(能力边界);不改 judgeArtifacts 与 result.json schema。

## 成功标准

① 问答类任务(天气)端到端 done、总耗时 <45s、notes 首行含 routing: answer;② 写文件任务仍走 work 档,五小节 plan.md 与验证留痕齐全;③ 「伪装成问答的改文件任务」被路由 work 档(升档单向纪律生效);④ npm test -- prompt-real-template 全绿(机读锚点行与 TASK_TEXT 单次出现约束保持)。

## 执行范围

仓库:resources/prompts/default.md(唯一实质文件);dsh-plugin 重打包(vendor/prompts 随包)。机器态部署:~/.dispatch/prompts/default.md 用户目录副本同步(loadPromptTemplate 用户目录优先,不同步则改动不生效)、web profile 插件重装、服务重启。

## 执行内容

default.md 增设档位路由:路由规则三行(用户显式要求方案/验证→work reason=user_explicit;需创建/修改工作区文件或含不可逆动作→work reason=effect_requires_work;其余→answer reason=simple_direct_answer),置于 Phase 1 之首;answer 档差异集中一处声明(plan.md 用薄骨架=任务理解+路由判定两节;验证允许单一可靠来源并注明来源与获取命令;免多源核验与回归);升档单向纪律(answer 档严禁改文件,发现需要改文件必须先升 work 补完整 plan);§6 增 answer 薄骨架与 notes 首行 routing 格式(routing: <档> — <reason>)。约束:不重排既有章节编号、交叉引用保持有效、机读锚点行与 TASK_TEXT 单次出现原样、模板整体长度增幅控制在 +40 行内。实施后 npm test -- prompt-real-template 回归,dsh-plugin build+test+pack。部署(协调者):同步用户目录模板→重装插件→重启→跑验收。

## 验收方案

按 success_criteria ①-④ 逐条 acceptance record:①③经 3080 HTTP invoke 真实派单实测;②重跑写文件型任务核对产物;④测试命令留痕。

## 是否需要 Acceptance 资产闭环

```json
true
```

## Knowledge 影响

unchanged

## 约束

模板为全 agent 共用,措辞按最弱模型设计:判据一票定档、编号步骤、不堆散文;~/.dispatch/prompts/default.md 是用户可编辑真源,部署必须同步该副本(代码注释已载,不另立知识)。

## 风险与回滚

自路由误判:answer 误入 work 仅多花时间;work 误入 answer 被升档单向纪律拦截,残余风险=问答答案少交叉核验(以标注来源补偿)。回滚:还原 default.md 与用户目录副本、重打包重装即可,无状态迁移。

<!-- docs-harness:plan-governance:start -->
## 资产治理

- 关联验收：`docs/acceptance/task-tier-routing.json`
- 需要 Acceptance：true
- Knowledge 影响：unchanged
<!-- docs-harness:plan-governance:end -->
