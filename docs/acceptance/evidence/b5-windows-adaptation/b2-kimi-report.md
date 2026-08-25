# B5 批2 收尾报告 — 跨平台脚本、路径审计与 worktree 文件锁实测

环境:Windows 11, node v24.14.1, git 2.54.0.windows.1, 全局 `core.autocrlf=true`。

## 改动文件清单

生产代码:

- `package.json` — `test` 脚本由 POSIX env 前缀语法改为 `node scripts/run-vitest.mjs`。
- `src/core/gitops/index.ts` — `removeWorktree` 加有限重试与残留补删(第 4 步实测驱动,详见下);新增模块级常量 `REMOVE_MAX_ATTEMPTS=3`、`REMOVE_RETRY_INTERVAL_MS=500`、`WT_LOCK_DENIED`、`WT_NOT_REGISTERED` 与 `sleep` 助手;导入补 `existsSync`/`rmSync`。

脚本与配置:

- `scripts/run-vitest.mjs`(新增)— 零依赖 node 启动器:`createRequire` 取 electron 二进制路径,`spawn` 拉起 `node_modules/vitest/vitest.mjs run`,env 注入 `ELECTRON_RUN_AS_NODE=1`,`stdio: inherit`,透传 `argv.slice(2)` 与退出码(信号终止时以同信号自杀,保真 POSIX 语义;`error` 事件报错并置退出码 1,不吞)。无平台分支,darwin 行为等价。
- `eslint.config.mjs` — 新增 `scripts/*.mjs` 块声明 `process`/`console` 只读全局(既有配置只覆盖 `tests/fixtures/*.cjs`,新启动器是 plain JS 会触 no-undef)。

测试:

- `tests/fixtures/git-repo.ts` — `makeGitRepo` 增加仓库级 `core.autocrlf false`(行尾与机器全局配置解耦)。
- `tests/executor.test.ts` — 用例⑥ `prepare_cmd` 按平台各写一份(win32 `echo ... 1>&2 & exit 7` / POSIX `>&2; exit 7`,带注释)。
- `tests/workflow-executor.test.ts` — 用例② 断言前对 mock-prompts.log 做 `\r\n→\n` 归一(带注释)。另含 prettier 对该文件一处 it.each 的机械换行重排(无逻辑变化)。
- `tests/follow-up.test.ts` — 「真实执行 done→面板两轮→完成合并」用例显式超时 15s(win32 进程拉起开销大,默认 5s 不够,带注释)。另含 prettier 对两处超长 import/调用的机械重排(无逻辑变化)。
- `tests/gitops-remove-worktree.test.ts`(新增)— win32 目录锁两例(见第 4 步)。

未触碰:renderer 业务逻辑、dsh-plugin/、dsh-headless-session/、docs/;未运行任何 git 写命令;未新增第三方依赖。

## 第 2 步:平台假设审计逐项结论

| # | 审计项 | 结论 | 处理 |
| --- | --- | --- | --- |
| 1 | 硬编码 `/` 路径拼接 | src/ 唯一命中 `src/shell/windows.ts:82` 是 dev-server URL 拼接(`/capture.html`),URL 语义非文件系统路径;其余全部 `path.join`。tests/ 无命中 | 无问题,不改 |
| 2 | `/bin/sh`、`/usr/bin/`、`sh -c` 残留 | `src/core/platform/darwin.ts` 的 `/usr/bin/which`、`/usr/bin/osascript` 为 darwin 平台内部固定命令;`src/core/proc/shell.ts` 已由批1收敛为 `SHELL_INVOCATION` 单点 | 无问题,不改 |
| 3 | `process.env.HOME`、`~` 展开 | 无命中;`src/core/paths.ts` 与 `bootstrap.ts` 均用 `os.homedir()`;`~/.dispatch` 仅出现在注释与 renderer 展示文案 | 无问题,不改 |
| 4 | `/tmp`、`os.tmpdir()` 误用 | src/ 无命中。tests/ 中 `/tmp/demo` 等只作为存入 DB 的字符串/模板变量值,不做真实 FS 访问;真实临时目录一律 `mkdtempSync(join(tmpdir(), ...))` | 无问题,不改 |
| 5 | 信号假设(platform/ 之外) | 唯一命中 `src/core/agents/detection.ts:46` `child.kill('SIGKILL')`:Node 在 Windows 对子进程 kill 支持 SIGTERM/SIGKILL(映射 TerminateProcess),且该 kill 作用于直接子进程非进程组,跨平台语义一致。`process.kill(-pid)` 仅存在于 darwin.ts | 无问题,不改 |
| 6 | 可执行位/chmod | src/ 无命中;tests/ 仅 `detection.test.ts:34` 的 `chmodSync(0o755)`,位于批1已改的 POSIX 分支(win32 走 .cmd 分支) | 无问题,不改 |
| 7 | 路径大小写/分隔符进入比较 | `gitops/index.ts` 的 `parseWorktreeList`/`startsWith` 解析的是 git porcelain 协议文本;`advanceBase` 用引用比较 `holder !== entries[0]`,git 给出的路径只回喂 git,不与文件系统路径做字符串比较;其余 `startsWith/toLowerCase` 命中均为业务文本或 win32 扩展名判定 | 无问题,不改 |
| 8 | 含空格路径拼进 shell 命令串 | `runShell`/`spawnShellDetached` 的全部调用点(executor prepare_cmd、adapter ready_check/start_cmd)执行的是用户配置命令原文,dispatch 不把路径变量拼进 shell 串;git 一律 `execFile` 数组参数 | 无问题,不改;第 5 步实测佐证 |

## 第 3 步:npm test 失败归因表

首轮全量(经新启动器):4 文件 5 失败。逐项归因:

| 失败用例 | 根因 | 归因 | 修复 |
| --- | --- | --- | --- |
| executor.test.ts ① 成功执行+干净合并(`'from-success\r\n' ≠ 'from-success\n'`) | 本机全局 `core.autocrlf=true`,合并后 checkout 出 CRLF | 测试侧平台假设 | `tests/fixtures/git-repo.ts` 仓库级 `core.autocrlf false` |
| retry-merge.test.ts 冲突解决重试(`'resolved\r\n'`) | 同上 | 测试侧平台假设 | 同上(fixtures 单点修复,两用例同根因) |
| executor.test.ts ⑥ prepare_cmd 失败(得 done) | 用例命令 `echo ... >&2; exit 7` 是 POSIX 语法;cmd 无 `;` 分隔符,整串被 echo 掉,退出码 0 | 测试侧平台假设 | 按平台各写一份(参照批1 detection.test.ts),cmd 版 `1>&2 & exit 7` 已实测退出码 7、stderr 含锚文本 |
| workflow-executor.test.ts ② reject→返工(`<review_feedback>\n无\n` 不包含) | dispatch 仓自身 checkout 的 `resources/prompts/wf-implement.md` 为 CRLF(autocrlf),模板原样拷入 promptsDir | 测试侧环境假设 | 断言前 `\r\n→\n` 归一(模板 CRLF 对真实 agent 无害,不动生产) |
| 首轮第 5 个失败(日志被 tail 截断未能确认身份) | 按后续轮次证据推断为 follow-up 超时 flaky(第 3 轮复现确认,见下) | — | 见下行 |
| follow-up.test.ts 真实执行全链路(第 3 轮复现:Test timed out in 5000ms) | 该用例无显式超时,跑一次 runTask+两轮 stream+合并,win32 进程拉起开销使其压线 5s(同文件其余重用例均有显式超时) | 测试侧平台假设(超时按 POSIX 速度校准) | 显式超时 15s |

real-*.test.ts(4 文件 9 用例)全程 skipped,门控条件维持,未触发。

无「真实生产 bug(与平台无关)」类失败。

## 第 4 步:worktree 文件锁实测记录

实验脚本:`.harness-tmp/b2-worktree-lock/`(git 忽略,不入仓),git 2.54.0.windows.1。

**实验 1(任务指定手法)**:临时仓库 + `worktree add`,node 子进程 `fs.openSync('r+')` 持有 worktree 内文件不关闭、进程常驻 → `git worktree remove --force` **退出码 0 直接成功**(libuv 打开文件带 share-delete,不构成锁)。任务指定手法复现失败。

**实验 2(cwd 占目录,模拟 agent 进程残留)**:子进程以 worktree 根为 cwd 常驻 →

- `remove --force` **exit 255**,stderr 原文:`error: failed to delete 'C:/.../wt': Permission denied`
- 杀进程后重试同一命令:**exit 128**,`fatal: '...' is not a working tree`

**实验 3(中间态确认)**:锁持续期间首击 255 后——`git worktree list --porcelain` 只剩主工作区(**登记已被 git 注销**)、目录残留但已空、任务分支仍在;再击恒 128;杀锁后 `rmSync` 残留目录 + `prune` + `branch -D` 全部成功。

**结论:复现成功(以 cwd 锁形态)**,且纯重试同一 git 命令无效(登记已注销)。按任务合同在 `removeWorktree`(gitops 所有者层,三个调用点 mergeAndFinish/retryMerge/cleanup 共用)实现:

- 失败形态匹配 `failed to delete '...': Permission denied`(实测 exit 255 原文)→ 有限重试,3 次、间隔 500ms;
- 匹配 `is not a working tree` 且目录仍在(锁中间态/既往残留,同为实测记录形态)→ `rmSync(recursive, force)` 补删残留,完成 `--force` 既定语义,保持 `cleanupTaskWorkspace` 重入可用;
- 超预算抛首个失败的 GitError 原样上抛;rmSync 删不动(锁未放)计入重试预算,不吞错;
- 其余失败形态维持原样直接抛 GitError,darwin 路径行为不变(锁形态在 darwin 不出现,分支不触发)。

单测 `tests/gitops-remove-worktree.test.ts`(`describe.runIf(win32)`,持锁手法同上):

1. 锁造成「注销+残留」中间态 → 放锁(等 `exit` 事件,不猜时)后单次调用补删残留、分支删除、不抛错;
2. 锁持续超预算 → 抛 GitError;放锁后重入成功。

## 第 5 步:含空格路径实测

一次性临时测试(跑完即删):项目路径 `dispatch test repo` 与 worktrees 目录 `dispatch test worktrees` 均含空格,跑 `createTaskWorktree → 提交 → mergeFlow(update_ref 推进) → removeWorktree` 全流程,**1 passed**,无修复需要。git 全程 execFile 数组参数,porcelain 路径解析不受空格影响。

## 第 6 步:验证命令

- `npm run typecheck`:exit 0,无错误。
- `npx eslint src/core tests scripts/run-vitest.mjs`:exit 0,零 error(初跑 7 个 no-undef 全在 run-vitest.mjs,经 eslint.config.mjs 补 scripts/*.mjs 全局后清零)。
- `npm test`(经 `node scripts/run-vitest.mjs`):**exit 0,Test Files 29 passed | 4 skipped (33),Tests 221 passed | 9 skipped (230)**。
- 触碰文件均 `prettier --write` 过,末轮 unchanged(executor.test.ts 的 prepareCmd 行超长 100 由 prettier 自动折行)。

## 重复逻辑自查

没有引入重复逻辑。依据:cmd 平台分支只出现在测试文件且各自注释标明;worktree 锁形态匹配常量 `WT_LOCK_DENIED`/`WT_NOT_REGISTERED` 与重试参数单点定义在 gitops/index.ts;补删/重试只存在于 `removeWorktree` 一份,三个调用点共用;测试等待放锁收敛为 `releaseDir()` 单函数两例共用。

## 新增抽象职责

- `scripts/run-vitest.mjs`:跨平台测试启动器,唯一职责是以 ELECTRON_RUN_AS_NODE 语义拉起 vitest 并保真透传参数/退出码。
- gitops 锁形态常量与 `sleep`:`removeWorktree` 重试判定的单一来源,语义即实测 stderr 原文,非通用工具。

## 未覆盖风险

- 锁失败形态匹配依赖 git for Windows 英文 stderr 原文;本地化 git 输出(非英文系统消息)可能不匹配,此时退化为原样抛错(不恶化,但重试不生效)。
- 「锁在重试预算内释放并于同一次调用内成功」的时序路径在满载套件下抖动,单测改为确定性覆盖(中间态+放锁后单次调用);3×500ms 预算对长驻残留进程(如不死的 agent)本就只能等用户重入清理。
- 首击 255 后 git 已删除 worktree 内全部文件才报删目录失败——重试补删的只是 git 自己没删完的残留,不扩大删除面;但若未来 git 版本改变失败顺序(先注销后删文件),`is not a working tree` 分支的补删可能面对非空目录,需届时重新实测。
- follow-up.test.ts 超时放宽至 15s 是校准而非根因修复;win32 上 stream 全链路本身耗时比 darwin 高,未做性能优化。
- darwin 未实测(本机为 Windows):改动对 darwin 的路径为零(锁形态分支不触发、测试 runIf 跳过、启动器无平台分支),由 CI macOS job 回归兜底(批3 范围)。
