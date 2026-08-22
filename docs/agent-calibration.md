# Agent CLI 校准记录

> 本文记录 DEFAULT_AGENTS(src/core/config/index.ts)中各 agent 参数的实测校准过程与结论。
> 校准方法:逐个 `<bin> --help` 确认无头/自动批准参数 → 用 tests/real-agents.test.ts
> (RUN_REAL_AGENTS=<agent> 按名启用)在真实 CLI + 真模板 + 临时 git 仓库上跑通
> 「立即执行 → 两阶段产物(plan.md / result.json)→ 自动合并回 base」全链路。
> 每次校准消耗真实配额,任务文本最小化,每个 CLI 成功一次即止。

## 结论总表(2026-08-22)

| agent | CLI 版本 | headless_args | auto_approve_args | prompt_via | log_filter | 实测结果 |
|---|---|---|---|---|---|---|
| claude-code | 2.1.229 | `-p --output-format stream-json --verbose` | `--dangerously-skip-permissions` | arg | claude_stream_json | 通过(见 tests/real-claude.test.ts,B2 线校准) |
| codex | 0.147.0 | `exec --skip-git-repo-check` | `--dangerously-bypass-approvals-and-sandbox` | arg | 无 | 通过(85s) |
| kimi | 0.36.1 | `--prompt` | (空,见下) | arg | 无 | 通过(49s) |
| qwen | 0.21.12 | (空) | `--approval-mode yolo` | stdin | 无 | 通过(153s) |
| dsh | 未安装 | 未校准 | 未校准 | — | — | `which dsh` 不存在,保留占位 |

实测命令(消耗配额,默认跳过):

```bash
RUN_REAL_AGENTS=codex npm test -- tests/real-agents.test.ts
RUN_REAL_AGENTS=kimi  npm test -- tests/real-agents.test.ts
RUN_REAL_AGENTS=qwen  npm test -- tests/real-agents.test.ts
# 逗号分隔可一次启用多个;claude-code 亦可经此测试启用
```

---

## codex(codex-cli 0.147.0)

### 最终参数

```
codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox <prompt>
```

- 无头模式:`codex exec [PROMPT]`,prompt 走位置参数(prompt_via=arg);不给参数时也可读 stdin。
- 自动批准:`--dangerously-bypass-approvals-and-sandbox` 一个 flag 同时关掉审批与沙箱,
  这是无人值守下既能改文件又能执行任意命令(含写归档目录)的唯一单 flag 组合。
  备选组合 `--sandbox workspace-write` 会把写入限制在 cwd(worktree)内,agent 将无法把
  plan.md / result.json 写进归档目录(归档在 worktree 外),故不可用;`--sandbox danger-full-access`
  仅放开沙箱、审批语义依赖默认值,不如单 flag 明确。Dispatch 的缓解措施 = worktree 隔离 +
  合并前冲突拦截 + 全量日志(spec §10)。
- `--skip-git-repo-check`:codex exec 默认拒绝在非 git 目录运行;加上后兼容非 git 项目,
  git 项目下为无害 no-op(本次实测即在 git worktree 中通过)。
- 旧版的 `--full-auto` 在 0.147.0 已不存在(实测 `codex exec --full-auto --help` 退出码 2)。

### 实测结果

- `RUN_REAL_AGENTS=codex npm test -- tests/real-agents.test.ts` → 通过,单测 85s。
- 两阶段产物齐备:plan.md 五小节齐全、result.json status=success 且验证命令留痕;
  改动只提交 file.txt,合并回 base 成功。

### 已知怪癖

- 默认 text 输出已足够人可读(含时间戳、思考摘要、exec 命令与 diff 回显),未配 log_filter;
  如需机读事件可用 `--json`(JSONL),当前无必要。
- 写归档文件时 codex 以 patch/diff 形式在 stdout 回显完整文件内容,日志略冗长但可接受。
- 运行结束偶发一条内部 ERROR 日志(`codex_models_manager … failed to renew cache TTL`),
  不影响退出码与产物,可忽略。
- 需要本机 `codex login` 登录态(实测时为 ChatGPT 登录)。

---

## kimi(Kimi Code CLI 0.36.1)

### 最终参数

```
kimi --prompt <prompt>
```

- 无头模式:`-p, --prompt <prompt>`「Run one prompt non-interactively and print the response」。
  prompt 必须是 `--prompt` 的内联值:GenericCliAdapter 把 prompt 追加在 argv 末尾,
  因此 **`--prompt` 必须是最后一个 flag**(其后不能再有其他 flag,否则会被当作 prompt 值)。
  kimi 无 stdin 喂 prompt 的方式(`echo x | kimi -p` 报 argument missing),prompt_via=arg。
- 自动批准:**留空**。print 模式禁止与 `--auto` / `--yolo` / `--plan` 组合
  (实测报错 `error: Cannot combine --prompt with --auto.`,二进制内另有
  `Cannot combine --prompt with --yolo.`)。print 模式本身即非交互执行,工具调用不经审批,
  无需额外 flag。
- 版本检测:`kimi --version` → `0.36.1`。

### 实测结果

- 第一次实测 `headless_args: ['--auto','--prompt']` 立即失败(exit 1,组合冲突报错,未耗配额);
  改为仅 `--prompt` 后通过全链路:plan.md + result.json + 只改 file.txt + 合并回 base。

### 已知怪癖

- `--auto`/`--yolo` 只用于交互(shell)模式,print 模式与之互斥——这与其他 CLI
  「无头 flag + 自动批准 flag」的二段式约定不同,故 kimi 的 auto_approve_args 为空是校准结论
  而非缺省未填。
- text 输出可读性好:assistant 消息以 `•` 列出,工具输出(shell/diff)原样回显,无需 log_filter;
  另有 `--output-format stream-json` 可选,当前无必要。
- print 模式会去掉步数/后台任务超时上限(二进制内 applyPrintModeConfigDefaults),
  长任务由 Dispatch 的任务级超时兜底。
- 需要 `~/.kimi-code/credentials` 登录态。

---

## qwen(Qwen Code 0.21.12)

### 最终参数

```
qwen --approval-mode yolo   # prompt 经 stdin 写入
```

- 无头模式:stdin 有管道输入时 qwen 自动进入非交互模式,无需 `-p`(帮助原文:
  「-p, --prompt  Prompt. Appended to input on stdin (if any)」)。GenericCliAdapter 的
  prompt_via=stdin 正好命中此路径,同时避开「`-p` 的值必须紧跟 flag」的 argv 顺序问题。
- 自动批准:`--approval-mode yolo`(auto-approve all tools)。`--yolo`/`-y` 为等价旧写法;
  `--approval-mode` 与 `--yolo` 均未出现在 `qwen --help` 输出中(帮助被裁剪),
  但在 CLI 源码(chunks/chunk-GP4IMBX5.js 的 yargs option 定义)中确认存在,并经实测生效。
  选 `--approval-mode yolo` 因语义显式、且是新版推荐入口。
- 版本检测:`qwen --version` → `0.21.12`。注意 `--version` 会短路参数校验,
  不能用它来探测 flag 是否存在。

### 实测结果

- `RUN_REAL_AGENTS=qwen npm test -- tests/real-agents.test.ts` → 通过:
  plan.md + result.json 写入归档目录(worktree 外,证明 yolo 下 shell/write 可越出工作区)、
  file.txt 追加并提交、合并回 base。

### 已知怪癖

- 启动即打印一条 yolo 无沙箱警告(stderr),属预期,留在日志中作审计线索;
  如嫌噪音可设 `QWEN_CODE_SUPPRESS_YOLO_WARNING=1`(当前配置 schema 不支持注入环境变量,未做)。
- 无头 text 模式过程**近乎静默**:执行中 stdout 几乎无输出,最终响应文本在结束时一次性输出,
  执行日志的实时性差(输出本身可读,故未配 log_filter;若后续要过程可见,可评估
  `-o stream-json` + 新增过滤器)。
- 本机为 ModelStudio Token Plan(openai 兼容)API key 认证,模型 qwen3.8-max;
  执行速度明显慢于 codex/kimi(单任务分钟级)。
- homebrew 安装的入口会转发到 `~/.qwen/updates/…` 下的自更新副本运行,版本以 `--version` 为准。

---

## dsh(未校准)

- `which dsh` 两次确认不存在(2026-08-22),无法实测。
- DEFAULT_AGENTS 保留占位 `{ bin: 'dsh' }`;检测层(detect)会因找不到二进制而在捕获窗置灰。
- 安装后需补:无头/自动批准参数、`ready_check_cmd`/`start_cmd`(spec §5.2 要求守护进程先行),
  并用 `RUN_REAL_AGENTS=dsh npm test -- tests/real-agents.test.ts` 验证(测试已支持按名启用)。

---

## 未解决问题

1. dsh 未安装,整体未校准(见上)。
2. qwen 无头模式过程日志近乎静默,详情页「执行日志尾部」在 qwen 任务运行中参考价值低;
   如需实时过程,可改配 `-o stream-json` 并新增对应 log_filter(本次按「输出可读即不过滤」原则未做)。
3. kimi 的 `--prompt` 必须内联值 + 必须位列最后,这一约束由 DEFAULT_AGENTS 注释与本文档共同记录;
   若未来 adapter 支持 prompt 占位符插值,可解除该顺序耦合。
