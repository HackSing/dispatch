# 任务:B5 批1 — platform 层 win32 实现

你在 dispatch 仓库(Electron 任务调度应用,TypeScript,vitest)工作。本仓库 core 的平台抽象层目前只有 darwin 实现,win32 下 `getPlatformOps()` 直接抛错。你的任务是补齐 Windows 实现。执行合同见 `docs/plans/b5-windows-adaptation.md` 的「批1」部分,本文件是其展开,冲突时以本文件为准。

## 硬性纪律(违反任何一条=任务未完成)

1. 只改本文件列出的文件,不碰 renderer、gitops、数据库、dsh-plugin、docs。
2. 不运行任何 git 写命令(不 commit、不 add、不 stash);改动留在工作区由审查者处理。
3. 不新增任何第三方依赖。
4. 业务代码不感知平台:平台分支只允许出现在 `src/core/platform/` 与 `src/core/proc/` 内。`GenericCliAdapter`、`session-transport` 只能通过 PlatformOps 接口间接使用平台能力,内部不得出现 `process.platform` 判断,也不得出现 agent 特有分支。
5. 错误不许吞(除非本文件明确要求 best-effort 容错并注释原因);单函数≤60 行,单文件≤500 行。
6. 代码风格跟随现有文件(无分号、单引号、中文注释风格);完成后对触碰过的文件跑 `npx prettier --write <files>`。
7. darwin 行为零变化:`darwin.ts` 现有三个方法的实现逻辑不许改动(只允许按第 2 步新增方法)。

## 现状(动手前先读这些文件)

- `src/core/platform/index.ts` — PlatformOps 接口 + getPlatformOps(),win32 走 default 抛错。
- `src/core/platform/darwin.ts` — darwin 实现,风格与容错语义的参照物。
- `src/core/proc/shell.ts` — 硬编码 `/bin/sh`。
- `src/core/agents/generic-cli-adapter.ts` — detect() 第 37 行已用 findBinary 解析但第 40 行 execFile 仍用未解析的 `this.config.bin`;run() 第 71 行 spawn 也用未解析的 bin。
- `src/core/agents/session-transport.ts` — StreamTransport.open() 第 87 行 spawn(config.bin, ...),opts 里已有 platform。
- `tests/generic-cli-adapter.test.ts` — 用真实 getPlatformOps(),这是现在整个测试套件在 Windows 全挂的原因之一。

## 第 1 步:新增 `src/core/platform/win32.ts`

实现 `PlatformOps`(含第 2 步新增的方法):

- `killTree(pid)`:`execFile('taskkill', ['/PID', String(pid), '/T', '/F'])`。进程已退出/不存在时 taskkill 非零退出——静默返回(与 darwin killTree 的 best-effort 语义一致,注释说明)。不需要宽限期轮询(taskkill /F 即强杀)。
- `findBinary(name)`:`execFile('where', [name])`,非零退出返回 null;输出按行拆,取第一个非空行 trim 后返回(where 的输出顺序即 cmd 的解析顺序,第一行就是命令行下会执行的那个)。返回的是含扩展名的完整路径。
- `openTerminal(cwd, command)`:`execFile('cmd.exe', ['/d', '/s', '/c', 'start "Dispatch" /d "<cwd>" cmd /k <command>'], { windowsVerbatimArguments: true })`,cwd 外层加双引号处理含空格路径;command 是用户配置的原始命令串,原样拼接。失败 reject,错误消息格式对齐 darwin 的 `打开终端失败: ...`。

## 第 2 步:PlatformOps 增加进程调用收敛点

背景:Node 修复 CVE-2024-27980 后,`spawn`/`execFile` 不带 shell 无法直接执行 `.cmd`/`.bat`(EINVAL)。npm 全局安装的 agent CLI 在 Windows 上多为 `.cmd` shim,必须经 `cmd.exe /d /s /c` 执行,且参数需按 cmd 语义转义。

在 `index.ts` 的 `PlatformOps` 接口新增:

```ts
export interface SpawnPlan {
  file: string
  args: string[]
  /** win32 经 cmd.exe 包装时为 true,调用方原样透传给 spawn/execFile */
  windowsVerbatimArguments?: boolean
}

/** 把 findBinary 解析出的完整路径 + 参数转成可直接 spawn/execFile 的调用形状 */
buildSpawn(binPath: string, args: string[]): SpawnPlan
```

- darwin 实现:恒等透传 `{ file: binPath, args }`。
- win32 实现:扩展名为 `.exe`(或其他可直接执行的)→ 恒等透传;`.cmd`/`.bat` → `{ file: 'cmd.exe', args: ['/d', '/s', '/c', <转义后的完整命令行>], windowsVerbatimArguments: true }`。
- **转义算法不要自己推导**:直接移植 `node_modules/cross-spawn/lib/util/escape.js`(该实现久经生产验证,注释注明移植来源)。要点:escapeCommand 对命令路径做 `^` 元字符转义;escapeArgument 按 https://qntm.org/cmd 算法处理反斜杠与引号、整体加引号、`^` 转义元字符;目标是 `.cmd`/`.bat` 时按 cross-spawn parse.js 的做法启用 doubleEscapeMetaChars(批处理会对参数再解析一次,需二次 `^` 转义)。完整命令行 = `[escapeCommand(binPath), ...args.map(a => escapeArgument(a, isCmdFile))].join(' ')`。正确性以第 6 步的真实 .cmd 往返测试为准,不要在头脑中长篇推演 cmd 解析边角。
- **含 `\r` 或 `\n` 的参数无法安全穿过 cmd.exe**:此时 throw,错误消息说明「Windows 上 .cmd/.bat shim 不支持含换行的参数,建议安装原生 exe 版本或将该 agent 的 prompt_via 配置为 stdin」。这是显式暴露而非静默截断,不算吞错。

## 第 3 步:`index.ts` 加分支

`case 'win32': return win32Ops`。其他平台维持现状抛错(消息里的「dev-plan B5」引用改为「Linux 未支持」之类的中性表述,因为 B5 就是本次)。

## 第 4 步:`src/core/proc/shell.ts` 跨平台

- 模块级按 `process.platform` 选定 shell 调用形状:POSIX 维持 `['/bin/sh', '-c', cmd]`;win32 用 `['cmd.exe', '/d', '/s', '/c', cmd]` 且 options 加 `windowsVerbatimArguments: true, windowsHide: true`(cmd 串是用户为本平台写的配置,原样透传,不做转义)。
- `runShell` 与 `spawnShellDetached` 都走同一形状(抽一个模块内私有 helper,不复制粘贴);`spawnShellDetached` 在 win32 上必须 `windowsHide: true` 防止弹出控制台窗口。
- 文件头「B5 Windows 需在此扩展」的注释同步更新为现状描述。

## 第 5 步:消费链改造(spawn 调用面收敛)

1. `generic-cli-adapter.ts` `detect()`:已有的 findBinary 结果 `bin` 经 `this.platform.buildSpawn(bin, this.config.version_args)` 得到 plan,`execFile(plan.file, plan.args, { windowsVerbatimArguments: plan.windowsVerbatimArguments }, ...)`。
2. `generic-cli-adapter.ts` `run()`:spawn 前先 `await this.platform.findBinary(this.config.bin)`,为 null 时 reject 错误消息 `agent 进程启动失败: <bin>: 未找到可执行文件`(与现有 child error 分支的消息风格一致);解析成功后经 buildSpawn spawn。stdin/stdout 管线、detached、信号处理逻辑全部不变。
3. `session-transport.ts` `StreamTransport.open()`:同样先 findBinary(null → reject `会话进程启动失败: <bin>: 未找到可执行文件`),再 buildSpawn 后 spawn。其余逻辑不变。
4. 逐一检查仓内其他 `spawn(`/`execFile(` 调用点(用 grep),凡以「用户配置的 agent bin」为执行目标的都必须收敛到 buildSpawn;以固定系统命令(git、taskkill、where、osascript、/bin/sh、cmd.exe)或 node 为目标的不用动。把检查结论(每个调用点:文件、行、是否需要收敛、为什么)写进收尾报告。

## 第 6 步:测试

新增 `tests/platform-win32.test.ts`,用 `describe.runIf(process.platform === 'win32')`(darwin CI 自动跳过):

1. `findBinary('git')` 返回以 `.exe` 结尾的存在路径;`findBinary('绝不存在的命令xyz')` 返回 null。
2. `killTree`:spawn 一个会再 spawn 孙进程的 node 脚本(参照 tests/fixtures 现有 mock 风格新建 fixture),killTree 后轮询确认父与孙都已退出(用 `process.kill(pid, 0)` 探活)。
3. `buildSpawn`:`.exe` 路径恒等透传;临时目录写一个 `echo-args.cmd`,内容用 `@node -e "console.log(JSON.stringify(process.argv.slice(1)))" %*`(node 打印 argv JSON,避免 cmd echo 对参数再解析的坑),经 buildSpawn + spawn 真实执行,断言 JSON.parse 后的参数数组与输入逐一相等,覆盖:含空格、双引号、中文、`%PATH%` 字面量、`&`、`^`;含 `\n` 的参数 → throw。
4. 转义纯函数的直接单测(不依赖真实进程的快速路径)。

另外把 `tests/generic-cli-adapter.test.ts` 里因本次接口变化而挂掉的地方修好(它用真实 getPlatformOps(),批1 后在 Windows 上应能构造成功;若个别用例仍有平台假设,修测试本身,不为迁就测试改生产代码语义)。

## 第 7 步:验证(全部在本机 Windows 上跑,输出附进报告)

```powershell
npm run typecheck
npm run lint
$env:ELECTRON_RUN_AS_NODE='1'; npx electron ./node_modules/vitest/vitest.mjs run tests/platform-win32.test.ts tests/generic-cli-adapter.test.ts tests/detection.test.ts tests/session.test.ts
```

注意:npm test 整套在 Windows 上还有批 2 才修的脚本问题,本批只要求上面列的聚焦测试全绿 + typecheck/lint 干净。若聚焦测试暴露出与本批无关的既有失败,不要顺手修,归因写进报告。

## 收尾

把报告写到仓库根 `.kimi-report-b1.md`:实际改动文件清单、第 5.4 步的调用点核对表、执行过的命令与退出结果、是否引入重复逻辑(答"没有"要给依据)、新增抽象(buildSpawn/转义函数)各自职责、未覆盖风险。

## 审查意见(第 1 轮,待修复)

**R1 — findBinary 取第一个非空行在真实环境选错文件(已实证)。**
本机 `where codex` 输出(npm 全局安装的典型布局):

```
C:\Users\freed\AppData\Roaming\npm-codex-latest\codex        ← 无扩展名 sh 脚本,cmd 无法执行
C:\Users\freed\AppData\Roaming\npm-codex-latest\codex.cmd
C:\Users\freed\AppData\Roaming\npm\codex
C:\Users\freed\AppData\Roaming\npm\codex.cmd
```

当前实现返回第一行(无扩展名 sh 脚本),buildSpawn 会把它包进 cmd.exe,而 cmd 根本无法执行无扩展名文件 → codex 检测/执行必然失败。npm 全局装的所有 agent CLI 都是这种布局,影响面不止 codex。

修复要求:
1. 从 where 输出中选择**第一个扩展名属于可执行集合(.exe/.com/.cmd/.bat)的行**;全部行都不可执行时返回 null(如实报告找不到可执行文件,不返回跑不起来的路径)。
2. 选择逻辑抽成导出纯函数(如 `pickExecutable(lines: string[]): string | null`),findBinary 复用。
3. 单测:用上面 codex 的真实四行输出作 fixture 断言选中 `...\npm-codex-latest\codex.cmd`;全无扩展名行 → null;既有 findBinary 用例保持全绿。
4. 修完重跑第 7 步验证命令,并在 `.kimi-report-b1.md` 末尾追加「审查修复」一节记录改动与验证输出。
