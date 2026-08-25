# B5 批1 审查者独立验证记录

审查者:主 agent(Claude);实施者:kimi CLI 0.38.0(无头 `-p` 模式,任务书见 b1-task-brief.md,实施报告见 b1-kimi-report.md)。日期:2026-08-25。

## 独立复跑结果(Windows 11 本机,Electron 38 / Node 22)

- `npm run typecheck`:exit 0。
- `npx eslint src/core tests`:0 error(全仓 lint 的 64 个既有 error 全部位于 dsh-plugin/ 与 dsh-headless-session/,与本批无关,单独归因)。
- `ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/vitest/vitest.mjs run tests/platform-win32.test.ts tests/generic-cli-adapter.test.ts tests/detection.test.ts tests/session.test.ts`:**Test Files 4 passed (4),Tests 38 passed (38)**(含 killTree 真杀进程树、.cmd 特殊参数真实往返、escapeCmdArg 纯函数、pickExecutable 选择逻辑)。

## 审查发现与修复闭环

- **R1(CONFIRMED,已修复)**:findBinary 原实现取 where 输出第一个非空行;本机实证 `where codex` 首行是无扩展名 sh 脚本(npm 全局安装布局),cmd.exe 无法执行 → codex 类 agent 必然检测/执行失败。修复:新增纯函数 `pickExecutable`,取第一个扩展名 ∈ {.exe,.com,.cmd,.bat} 的行,全不可执行返回 null;以 `where codex` 真实四行输出作 fixture 断言选中 `codex.cmd`。修复后 38 用例全绿(+3)。
- 消费链逐段核对(spawn/execFile 全仓 grep):detect/run/session-transport/detection 四处收敛到 buildSpawn,其余为固定系统命令目标,核对表见 b1-kimi-report.md 第 5.4 节,审查者抽查一致。
- darwin 零回归:`git diff darwin.ts` 仅新增 buildSpawn 恒等透传,既有三方法零改动。

## 本机 agent bin 实证(为 L3 检测验收预存)

| bin | where 解析 | 形态 |
|---|---|---|
| git | `D:\Program Files\Git\cmd\git.exe` | .exe 直执行 |
| claude | `C:\Users\freed\.local\bin\claude.exe` | .exe 直执行 |
| kimi | `C:\Users\freed\.kimi-code\bin\kimi.exe` | .exe 直执行 |
| qwen | `...\qwen-code\bin\qwen.cmd` | .cmd 经 cmd.exe 包装(prompt_via=stdin,不触换行限制) |
| codex | 首行无扩展名 sh,`pickExecutable` 选中 `...\codex.cmd` | .cmd 包装(prompt_via=arg,多行 prompt 受换行限制,如实报错) |
| dsh | PATH 无(DSH Buddy 内置,不单独安装) | 检测将如实报"未找到" |

## 未覆盖(随批次推进)

- openTerminal 无自动化测试(真 GUI 窗口),L3 阶段人工冒烟。
- npm test 全量脚本 POSIX 语法属批 2;CI windows job 属批 3;B2 全链路实机与 NSIS 属批 3 后验收。
