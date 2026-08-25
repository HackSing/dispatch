# 任务:B5 批2 — 跨平台脚本、路径审计与 worktree 文件锁实测

你在 dispatch 仓库工作。批1(platform 层 win32 实现)已完成并提交(见 git log 最新提交与
`docs/acceptance/evidence/b5-windows-adaptation/`)。本批目标:让整个测试套件在 Windows 上可运行,
清掉全仓平台假设,实测 worktree 文件锁行为。执行合同见 `docs/plans/b5-windows-adaptation.md` 批2。

## 硬性纪律(与批1相同,违反=未完成)

1. 不碰 renderer 业务逻辑、dsh-plugin/、dsh-headless-session/、docs/(evidence 目录除外,见收尾)。
2. 不运行任何 git 写命令(不 commit/add/stash);改动留工作区。
3. 不新增第三方依赖(cross-env 之类一律禁止,用 node 内置能力)。
4. 平台分支只允许在 src/core/platform/ 与 src/core/proc/;测试文件里的平台分支允许但要有注释。
5. 错误不许吞;单函数≤60 行;修改跟随现有代码风格,收尾对触碰文件跑 prettier。
6. **证据准入**:任何新增 retry/fallback/兼容分支,必须先在本机复现该失败并把复现记录写进报告;复现不出来就不加代码,只写报告。

## 第 1 步:test 脚本跨平台化

`package.json` 的 `test` 脚本目前是 `ELECTRON_RUN_AS_NODE=1 electron ./node_modules/vitest/vitest.mjs run`,
POSIX env 前缀语法在 Windows 不可用。改为零依赖 node 启动器:

- 新增 `scripts/run-vitest.mjs`(node 脚本):设置 `process.env.ELECTRON_RUN_AS_NODE='1'`,用
  `child_process.spawn` 拉起 `require('electron')`(electron npm 包导出二进制路径)运行
  `./node_modules/vitest/vitest.mjs run`,透传剩余命令行参数与退出码。stdio 直接 inherit。
- `test` 脚本改为 `node scripts/run-vitest.mjs`。
- macOS 兼容:启动器不含任何平台分支需求,darwin 上行为等价(退出码、参数透传都要保真)。
- 注意 scripts/ 目录已有 python 的 harness 脚本,不要动它们。

## 第 2 步:全仓平台假设审计(src/ 与 tests/)

逐项 grep 并给出结论(修复或"无问题"判定,逐条写进报告):

1. 硬编码 `/` 路径拼接(找字符串拼接路径的点,应使用 path.join/URL;注意 git 命令输出里的 `/` 是 git 语义,不是文件系统路径,不要误改)。
2. `/bin/sh`、`/usr/bin/`、`sh -c` 残留(批1已收敛 proc/shell.ts,查是否还有别处)。
3. `process.env.HOME`、`~` 展开假设(应使用 os.homedir())。
4. `/tmp` 或 `os.tmpdir()` 误用差异。
5. 信号假设:`SIGTERM`/`SIGKILL`/`process.kill(-pid)` 在 platform/ 之外的出现点。
6. 可执行位/chmod 假设(Windows 无执行位)。
7. 路径大小写与分隔符进入比较逻辑的点(如用字符串比较路径)。
8. 含空格路径:找拼接进 shell 命令串的路径变量,确认有引号处理(gitops 用 execFile 数组参数的不受影响,不要误改)。

修复原则:测试侧假设修测试;生产侧假设修生产但保持 darwin 行为不变;拿不准的不改,写进报告标"存疑"。

## 第 3 步:npm test 全量在 Windows 跑通

跑 `npm test`(经第 1 步新脚本)。对每个失败测试归因:

- 平台假设(测试侧)→ 修测试(参照批1 detection.test.ts 的做法:.cmd fixture、ping 替代 sleep 等)。
- 平台假设(生产侧)→ 修生产代码,darwin 语义不变。
- 真实生产 bug(与平台无关)→ **不修**,详细写进报告单独归因。
- 依赖真实 agent/网络的测试(real-*.test.ts)如默认跳过则维持;如未跳过而失败,查其门控条件并在报告说明。

目标:`npm test` 在本机全绿(或仅剩已归因的非本批失败,报告列明)。

## 第 4 步:worktree 文件锁实测(证据先行)

写一个临时实验脚本(放 scratch 临时目录,不入仓)复现:

1. 临时 git 仓库 + `git worktree add`;
2. 用 node 子进程持有 worktree 内某文件的打开句柄(fs.openSync 不关闭,进程常驻);
3. 运行 `git worktree remove --force` → 记录确切失败形态(退出码、stderr 文本);
4. 杀掉持锁进程后重试 → 确认成功。

结论分支:
- **复现成功**:在 `src/core/gitops/index.ts` 的 `removeWorktree`(或其唯一调用链的所有者层,自行考察
  `cleanupTaskWorkspace` 的现有重入语义后选最小改动点)加**有限重试**(如 3 次、间隔 500ms,仅对
  实测记录到的失败形态),超过次数原样上抛,不吞错。附带单测(用同样的持锁手法)。
- **复现失败**(git 自己能处理):不改任何代码,把实验记录写进报告。

## 第 5 步:含空格路径实测

临时目录造一个含空格的项目路径(如 `dispatch test repo`),跑一次 gitops 的 worktree 创建→移除
流程(可直接用现有测试设施 tests/fixtures/git-repo.ts 的工厂改参数,或写临时脚本),确认全流程可用。
若失败,按第 2 步原则修复。结果进报告。

## 第 6 步:验证

```powershell
npm run typecheck
npx eslint src/core tests scripts/run-vitest.mjs
npm test          # 经新启动器,全量
```

三条命令的退出码与关键输出进报告。

## 收尾

报告写到仓库根 `.kimi-report-b2.md`:改动文件清单、第 2 步逐项审计结论表、第 3 步失败归因表、
第 4 步实验记录(复现与否、失败形态原文)、第 5 步实测结果、验证命令输出、重复逻辑自查、新增抽象职责、未覆盖风险。
