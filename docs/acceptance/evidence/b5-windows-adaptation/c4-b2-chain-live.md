# c4 证据:Windows 实机 B2 全链路(真实小仓库 + 真实 kimi)

日期:2026-08-25。验证人:Claude(审查方),探测脚本独立编写并执行。

## 方法

探测脚本(附录)以隔离 `DISPATCH_HOME`(mkdtemp)加载 dsh-plugin 0.1.4 的
`core-runtime.js`(即批1-批4 后含 win32 支持的 vendor core),在临时真实 git 仓库上创建
kimi 立即执行任务:「在 README.md 末尾追加一行文本 hello-from-b5」,轮询状态直至终态,
再核对 main 分支文件内容、归档目录与 git 历史。

## 输出(关键行,Windows 11 本机)

```
[task] created 4aa15299-bbc0-41e8-a5e9-cf4e81710773
[status] running
[status] done
[final] status=done
[merged] true
[archive] output.log, plan.md, result.json, task.md
[git-log] b2abb89 在 README.md 末尾追加一行 hello-from-b5 | 5af3f29 init
B2_CHAIN_PROBE_END
```

链路逐环确认:

1. **捕获/建任务**:projects.create + tasks.create(triggerType=immediate)成功
2. **执行**:win32 buildSpawn 拉起真实 kimi(.cmd shim 经 cmd.exe 包装),worktree 内完成
   两阶段工单(plan.md → result.json)
3. **自动合并**:README.md 在 **main 分支** 上包含 `hello-from-b5`(merged=true),
   git log 显示任务提交已并入
4. **归档**:archiveDir 四件套齐全(output.log, plan.md, result.json, task.md)
5. **终态**:done

## 探测中的非缺陷现象(如实记录)

探测早期版本曾对同一任务重复触发 maybeRunImmediate,状态机以
`illegal task transition: running -> running` 拒绝——这是状态机对非法迁移的正确防护,
非产品缺陷;最终探测(上述输出)为单次触发。

## 附录:探测脚本

脚本 `probe-b2-chain.mjs` 全文见本目录 [c4-probe-b2-chain.mjs](c4-probe-b2-chain.mjs)。

## 结论

c4 通过:Windows 实机上 捕获→立即执行→自动合并→归档 全链路以真实 agent 跑通。
