> 状态：已实施-仅追溯（代码已是真源，2026-08-22 核对）
<!-- docs-harness:plan-document/v1 -->

# dsh 追问面板与沙箱放行:headless-dispatch 专用 profile 与会话续接

- 冻结合同：`sha256:589495f23dc240fe638f0b1bc2e6ab79b3e393823e673c2c27d38075490f3e17`
- 关键符号：`dsh-headless-session`、`headless-dispatch`、`agents.resume`、`sandbox-policy`

## 背景

dsh agent 校准(--profile headless)后一次性执行已通,但实测暴露两个缺口:(a) headless 栈 sandbox-policy 默认 workspace-write,拒写 worktree 之外的归档 OUT_DIR,任务终态 no_plan;(b) headless CLI 无 --session-id/--resume,supportsSession/followUpTransport 判空,追问面板不可用。dsh 侧地基已逐项验证:headless runner 的 agents.create 本就接受调用方 sessionId;dsh-agent 有现成 agents.resume({resumeSessionId});会话持久层(dsh-session-persistence-jsonl)明确支持 cwd 未知时按 id 跨项目目录查找;bundle patch 行(headless-startup/headless-runner/sandbox-policy/approval)均 id 可寻址,可禁用、插入与覆写配置。

## 目标

dsh 任务产物可落归档目录(no_plan 消除),追问面板以 round 传输点亮;dispatch core 零代码改动,全部经 AgentConfig 模板与 dsh profile 配置达成。

## 非目标

不做 stream 传输(dsh 无 claude stream-json 线格式);不在 dispatch core 加无状态重放降级传输;不修改上游 dsh-headless 包与现有 headless profile;不解决打包态 DSH Buddy 的 dsh PATH 分发问题(留待 B4/打包批次)。

## 成功标准

① dsh --profile headless-dispatch --session-id <uuid> "<任务>" 能在 cwd 之外的指定目录写文件、会话以 session-<uuid> 落盘、exit 0;② dsh --profile headless-dispatch --resume <uuid> "<追问>" 从不同目录执行仍能续接并引用上一轮内容;③ dispatch 插件重装后,dsh 任务端到端终态 done(plan.md/result.json 落归档,sessionId 落库);④ 面板链路 task:follow-up-start/send/finish 对 dsh 任务全通。

## 执行范围

dispatch 仓库:新增顶层 dsh-headless-session/ 包(startup.js/index.js/cordis.patch.yml/package.json/README);src/core/config/index.ts DEFAULT_AGENTS.dsh 三件套;docs/agent-calibration.md dsh 条目;dsh-plugin vendor 重建与 tgz 重打。机器态:新建 ~/.dsh/profiles/headless-dispatch(package.json/cordis.yml/pnpm-workspace.yaml/cordis.patch.yml,以 headless profile 为模板);~/.dispatch/config.json dsh 条目手动同步;~/.dsh/restart-web.sh 替换为 Electron-as-Node + 内嵌 dsh 入口 + dev PATH。

## 执行内容

B1(dsh 侧,不动 dispatch):@aiwaretop/dsh-headless-session 包,startup 以 commander 提供 --session-id <id> 与 --resume <id>(互斥)+ [task...],发布 dispatchHeadlessStartup 服务;runner fresh 走 agents.create({sessionId: SessionId('session-'+id)}),resume 走 agents.resume({resumeSessionId}),两径共用 followup→whenIdle→sessions.flush→summarize 打印→按 turn reason 退出(镜像上游 dsh-headless);bundle patch 骑在 dsh-base+dsh-headless 上:disable headless-startup/headless-runner 两行,insert 自身 startup/runner 两行,覆写 sandbox-policy config.mode=danger-full-access 与 approval config.policy=never;profile headless-dispatch bundles=[dsh-base, dsh-headless, @aiwaretop/dsh-headless-session],依赖以 file: tgz 安装。B2(dispatch 侧):DEFAULT_AGENTS.dsh 改 headless_args=[]、session_args=['--profile','headless-dispatch','--session-id','{SESSION_ID}']、resume_headless_args=['--profile','headless-dispatch','--resume','{SESSION_ID}'](launcher flag 必须前置,--profile 并入 session_args,杜绝双 --profile);校准文档同步;seed-vendor→build→test→pack→web profile remove+add 重装→重启服务;本机 ~/.dispatch/config.json dsh 条目手动同步为新默认(absorb 不覆盖非空值,正式迁移机制留 B4)。B3:restart-web.sh 第 4 步替换为 ELECTRON_RUN_AS_NODE=1 + dsh-buddy-hotkey 内嵌 Electron/dsh 入口 + PATH 前置 dev shim 目录。

## 验收方案

按 success_criteria ①—④ 逐条以 acceptance record 记录真实命令与退出结果;④ 通过 3080 HTTP invoke 通道执行;最终 User Acceptance 由用户在 DSH Buddy 面板实操确认后以 --user-confirmed 记录。

## 是否需要 Acceptance 资产闭环

```json
true
```

## Knowledge 影响

updated

## 约束

dsh launcher flag 必须位于任务尾参之前且 --profile 在未知 flag 之前;GenericCliAdapter fresh argv = session_args + headless_args,故 headless_args 必须清空,否则出现双 --profile;absorbAgentDefaults 只吸收空值、不覆盖非空,本机 config 需一次性手动同步。

## 风险与回滚

danger-full-access + approval never 使 dsh 任务获得与 claude/codex/qwen 跳权限模式同级的信任,为显式决定,仅作用于 headless-dispatch profile;上游 0.1.1-rc.1 为 developer preview,patch 行 id 变更会破坏 disable/insert,升级时需比对 cordis.patch.yml;回滚:删除 headless-dispatch profile,config dsh 条目还原为 --profile headless。

## 当前约束

dsh 会话持久化按 cwd slug 分目录,面板 resume 发生在新 worktree,依赖持久层跨目录按 id 查找(类型契约已承诺,B1 验收①②实测);dispatch 会话 id 为裸 UUID,dsh SessionId 形如 session-<uuid>,插件负责规范化前缀。

## 候选方案

方案 B:dispatch core 增加无状态重放降级传输(所有无 resume 的 agent 均可点亮面板,但伪续接:工具状态丢失、token 逐轮膨胀、core 需引入第三种传输语义);方案 C:等上游 dsh-headless 自行支持 resume(不可控)。

## 真实取舍

方案 A 以对上游 patch 行 id 的耦合为代价,换取 dispatch core 零改动、真会话续接与沙箱策略随 profile 收口;方案 B 改动面在自家但产品语义劣化;方案 C 零成本但时点不可控。

## 最终决策

采用方案 A:自研 @aiwaretop/dsh-headless-session bundle + headless-dispatch 专用 profile,dispatch 侧纯配置接入。

## 边界与接口

dispatch↔dsh 的唯一边界是 CLI argv 契约(AgentConfig 三件套模板渲染);插件包对外仅暴露 startup 服务与 runner 插件及 cordis.patch.yml,不导出其他符号;profile 是沙箱/审批策略的唯一收口点。

## 兼容与迁移

现有 headless profile 与上游包保持原样;新装机器由 DEFAULT_AGENTS 直接得到正确配置;本机存量 config.json 一次性手动同步;web profile 插件按 remove+add 程序重装。

## 回滚或替代路径

逆序回退:恢复 restart-web.sh 备份→config dsh 条目还原 --profile headless 并清空 session 三件套→删除 ~/.dsh/profiles/headless-dispatch→(可选)重装旧 tgz;各步独立可执行,无数据迁移。

## 架构验收

success_criteria ③④ 为架构级验收(配置驱动的能力点亮,core 零 diff 以 git status 佐证);收尾 assets-check 通过。

## ADR 处理

不另立 ADR:决策与权衡已完整记录于本方案 decision/tradeoffs/rollback_strategy;方案失效时随 plan settle 废弃或被替代。

<!-- docs-harness:plan-governance:start -->
## 资产治理

- 关联验收：`docs/acceptance/dsh-headless-session-panel.json`
- 需要 Acceptance：true
- Knowledge 影响：updated
<!-- docs-harness:plan-governance:end -->
