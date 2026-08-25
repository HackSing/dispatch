# B5 批1 收尾报告 — platform 层 win32 实现

## 实际改动文件清单

生产代码:

- `src/core/platform/win32.ts`(新增)— win32 实现:`killTree`(taskkill /PID /T /F,best-effort 静默)、`findBinary`(where,取第一个非空行;路径形态输入 where 拒绝「Invalid pattern」,直接按存在性判定)、`openTerminal`(cmd start /d /k)、`buildSpawn`(.exe/.com 恒等透传,.cmd/.bat 经 `cmd.exe /d /s /c` 包装 + windowsVerbatimArguments)。转义为导出纯函数 `escapeCmdCommand` / `escapeCmdArg(arg, doubleEscapeMetaChars)`,算法逐行移植 `node_modules/cross-spawn/lib/util/escape.js`(qntm.org/cmd),.cmd/.bat 目标按 cross-spawn parse.js 对 cmd-shim 的做法二次 ^ 转义;含 \r/\n 参数显式 throw。
- `src/core/platform/index.ts` — `SpawnPlan` 接口 + `PlatformOps.buildSpawn` + `case 'win32'`;default 抛错消息改为中性表述。
- `src/core/platform/darwin.ts` — 仅新增 `buildSpawn` 恒等透传;既有三个方法实现零改动(diff 可证)。
- `src/core/proc/shell.ts` — 模块级 `SHELL_INVOCATION` 私有常量收敛 shell 调用形状(POSIX `/bin/sh -c`;win32 `cmd.exe /d /s /c` + verbatim + windowsHide),`runShell`/`spawnShellDetached` 共用,无复制粘贴;文件头注释更新为现状描述。
- `src/core/agents/generic-cli-adapter.ts` — `detect()` 用 findBinary 结果 + buildSpawn 后 execFile;`run()` 先 findBinary(null → throw `agent 进程启动失败: <bin>: 未找到可执行文件`)再 buildSpawn spawn;版本首行解析 `split(/\r?\n/)`(cmd 输出 CRLF,归属本批表面修复)。
- `src/core/agents/session-transport.ts` — `StreamTransport.open()` 改 async:先 findBinary(null → throw `会话进程启动失败: <bin>: 未找到可执行文件`)再 buildSpawn spawn,其余不变。
- `src/core/agents/detection.ts` — `probeVersion` 收敛到 `ops.buildSpawn`(binPath 来自用户配置 agent bin);版本首行解析同上改 `/\r?\n/`。

测试与 fixture:

- `tests/platform-win32.test.ts`(新增)— `describe.runIf(win32)`:findBinary(git→.exe / 不存在→null)、killTree 真实强杀父+孙进程轮询确认、已退出进程静默返回、buildSpawn .exe 恒等/.cmd 真实执行参数无损(含空格、双引号、中文、`%PATH%`、`&`、`^`)/含换行 throw、escapeCmdArg 纯函数单/双转义直接单测。
- `tests/fixtures/spawn-tree.cjs`(新增)— 父进程拉常驻孙进程并写 pid 文件(killTree 验证)。
- `tests/fixtures/dump-argv.cjs`(新增)— JSON dump argv(echo-args.cmd 参数回显)。
- `tests/generic-cli-adapter.test.ts` — 仅 ensureReady 两个用例的 ready_check/start_cmd 按平台各写一份(win32 cmd 语法);生产代码语义未为迁就测试改动。
- `tests/detection.test.ts` — `fakeOps` 补 `buildSpawn`(委托真实平台实现,接口变化直改);`makeScript` win32 写 .cmd、`sleep 5` 用 ping 等价物(平台假设修复,非本批生产问题)。

## 第 5.4 步 spawn/execFile 调用点核对表(grep src/ 全覆盖)

| 调用点 | 目标 | 是否收敛 | 理由 |
| --- | --- | --- | --- |
| src/core/agents/generic-cli-adapter.ts detect() | 用户配置 agent bin | 已收敛 | buildSpawn + findBinary 结果 |
| src/core/agents/generic-cli-adapter.ts run() | 用户配置 agent bin | 已收敛 | 同上 |
| src/core/agents/session-transport.ts StreamTransport.open() | 用户配置 agent bin | 已收敛 | 同上 |
| src/core/agents/detection.ts probeVersion | 用户配置 agent bin(findBinary 结果) | 已收敛 | 任务 5.4 要求 |
| src/core/bootstrap.ts:18 | git | 不动 | 固定系统命令 |
| src/core/gitops/index.ts:29 | git | 不动 | 固定系统命令 |
| src/core/platform/darwin.ts | which / osascript | 不动 | 平台内部固定系统命令 |
| src/core/platform/win32.ts | taskkill / where / cmd.exe | 不动 | 平台内部固定系统命令 |
| src/core/proc/shell.ts | /bin/sh / cmd.exe | 不动 | 固定 shell;cmd 串按合同原样透传 |
| tests/*(spawn node/electron fixture) | process.execPath | 不动 | 测试代码固定目标 |
| dsh-plugin/src、 dsh-headless-session | — | 无匹配(grep 验证) | 且属本批禁改目录 |

## 执行过的命令与退出结果

- `npx prettier --write <触碰文件>` ×3 轮:全部成功,末轮全 unchanged(风格零 diff)。
- `npm run typecheck`:exit 0,无错误。
- `npm run lint`:exit 1,64 errors **全部位于 `dsh-plugin/` 与 `dsh-headless-session/`**(no-undef / no-explicit-any,既有失败,属本批禁改目录,未顺手修);`grep -v dsh-` 复核,本批触碰文件零 error。
- `ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/vitest/vitest.mjs run tests/platform-win32.test.ts tests/generic-cli-adapter.test.ts tests/detection.test.ts tests/session.test.ts`:exit 0,**Test Files 4 passed (4),Tests 35 passed (35)**。
  - 过程中先暴露两处真实问题并已修复:① `where` 拒绝全路径输入(Invalid pattern)→ win32 findBinary 对路径形态输入改按存在性判定;② cmd 输出 CRLF 导致版本串带 `\r` → detection/adapter 版本首行解析改 `split(/\r?\n/)`。
- 未跑 `npm test` 全量:任务明确批 2 才修全量脚本问题,本批只要求聚焦测试。

## 收尾自查

- 是否引入重复逻辑:**没有**。shell 形状由 `SHELL_INVOCATION` 单点收敛,runShell/spawnShellDetached 共用;转义只存在 win32.ts 一份(escapeCmdCommand/escapeCmdArg),buildSpawn/测试均复用;跨平台差异只在 platform/ 与 proc/ 内,业务代码(adapter/transport/detection)只经 PlatformOps 接口,全文无 `process.platform` 判断(grep 可证,测试文件的平台分支属既有测试修复)。
- 新增抽象职责:`SpawnPlan`/`buildSpawn` —— 把「已解析 bin 路径 + 参数」收敛为可直接 spawn/execFile 的调用形状,是 CVE-2024-27980 后 .cmd shim 问题的唯一收敛点;`escapeCmdCommand`/`escapeCmdArg` —— cross-spawn 移植的 cmd 转义纯函数,后者支持 .cmd/.bat 的 %* 二次解析双转义;`SHELL_INVOCATION` —— shell.ts 内平台 shell 形状的单一来源。

## 未覆盖风险

- `openTerminal` 无自动化测试(起真实 GUI 窗口,不宜进 CI);仅保证与 darwin 相同的错误消息格式。
- `where` 输出按 UTF-8 解码,系统区域为 GBK 且 PATH 含非 ASCII 目录时可能乱码(小概率,未复现)。
- `%PATH%`、`&`、`^` 等参数的无损到达已在单层 cmd shim(echo-args.cmd)实证;嵌套多层 cmd shim(如 shim 再调 shim)未覆盖。
- `npm test` 全量在 Windows 上仍有批 2 范围的脚本问题,未验证;lint 全仓红为 dsh-* 目录既有失败,与本批无关。

## 审查修复

### R1 — findBinary 取第一个非空行在真实环境选错文件(已修复)

问题:本机 `where codex` 首行是无扩展名 sh 脚本(npm 全局布局:无扩展名脚本在前、.cmd 在后),原实现返回第一行,cmd 无法执行 → codex 等 npm 全局 agent CLI 检测/执行必然失败。

改动:

- `src/core/platform/win32.ts`:新增导出纯函数 `pickExecutable(lines: string[]): string | null` —— 从 where 输出选第一个扩展名属于可执行集合(`.exe`/`.com`/`.cmd`/`.bat`)的非空行,全部不可执行返回 null;`findBinary` 改为 `resolve(pickExecutable(stdout.split(/\r?\n/)))` 复用该函数(路径形态输入的存在性判定分支不变)。
- `tests/platform-win32.test.ts`:新增 `pickExecutable` describe 三例 —— codex 真实四行输出 fixture 断言选中 `...\npm-codex-latest\codex.cmd`;全无扩展名行 → null;.exe 优先且空行/空白行跳过。

验证(R1 修复后重跑第 7 步全部命令):

- `npx prettier --write src/core/platform/win32.ts tests/platform-win32.test.ts`:均 unchanged。
- `npm run typecheck`:exit 0。
- `npm run lint`:exit 1;出错文件清单(`grep -E "^D:" | sort -u`)14 个文件全部位于 `dsh-plugin/` 与 `dsh-headless-session/`,与本批无关的既有失败,未变。
- `ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/vitest/vitest.mjs run tests/platform-win32.test.ts tests/generic-cli-adapter.test.ts tests/detection.test.ts tests/session.test.ts`:exit 0,**Test Files 4 passed (4),Tests 38 passed (38)**(较修复前 +3,即 pickExecutable 新用例;既有 findBinary 用例保持全绿)。
