> 状态：有效（现行事实）
<!-- docs-harness:knowledge-document/v1 -->

# dsh agent 会话接入:headless-dispatch profile 与 CLI 契约

- 修订：1
- 关键符号：`dsh-headless-session`、`headless-dispatch`、`resume_headless_args`、`dispatchHeadlessStartup`
- 资产指纹：`sha256:8c18dce1f088ebb3fe699e7aafe37688e96559e86e63610b3d81b0b9514aa8a4`

## 摘要

dsh agent 经自研 headless-dispatch profile 获得 --session-id/--resume 与沙箱放行,dispatch 侧纯 DEFAULT_AGENTS 配置接入,追问面板走 round 传输

## 事实

### `profile.composition`

headless-dispatch profile = dsh-base + dsh-headless + @aiwaretop/dsh-headless-session(仓库 dsh-headless-session/ 包);bundle patch 禁用上游 headless-startup/headless-runner 两行并插入自研 startup/runner,同时覆写 sandbox-policy mode=danger-full-access 与 approval policy=never,仅本 profile 生效

证据：`dsh-headless-session/cordis.patch.yml`

### `cli.contract`

dsh 会话 CLI 契约:fresh = dsh --profile headless-dispatch --session-id <uuid> "<任务>",resume = --resume <uuid>;launcher flag 必须位于任务尾参之前且 --profile 先于本应用 flag,故 dispatch 的 --profile 并入 session_args 而 headless_args 留空(fresh argv = session_args + headless_args)

证据：`src/core/config/index.ts`、`docs/agent-calibration.md`

### `resume.cross-cwd`

dsh 会话按 cwd slug 落盘于 ~/.dsh/sessions,但持久层支持按 id 跨项目目录查找,面板在新 worktree 中 resume 旧 worktree 会话已实测通过(c2/c4);插件 runner 对裸 uuid 自动加 session- 前缀

证据：`dsh-headless-session/lib/index.js`、`docs/acceptance/evidence/dshs-c2-resume.txt`

### `plugin.no-deepseek-imports-exception`

profile 安装的第三方 host 插件可声明 @deepseek-ai/* 为 peerDependencies 并直接 import(loader 解析到宿主运行时),dsh-headless-session 与 docs-harness 均为此形态;profile 的 pnpm 仅安装其 dependencies(如 commander)

证据：`dsh-headless-session/package.json`
