 
// 测试用 mock agent:纯 Node 脚本,不依赖仓库代码,由模式参数驱动行为。
// 通过 GenericCliAdapter 以 bin=process.execPath + headless_args=[本脚本] 方式喂入,
// 与真实 agent 走同一份适配器代码。OUT_DIR 从提示词的「OUT_DIR: <path>」行解析。
//
// 模式来源(W1b 起):headless_args 里的 --mock-mode=<mode> 优先(工作流主/子角色各自
// AgentConfig 注入,互不串扰),否则读 MOCK_MODE 环境变量(既有单点测试用法不变)。
//
// 基础模式:
//   success      写合法 plan.md + result.json,并在 cwd 改文件后 git add+commit(非 git 跳过)
//   no_result    只写 plan.md
//   bad_json     result.json 写非法内容
//   fail_status  result.json status=failed
//   nonzero_exit 直接以退出码 3 退出
//   hang         写 pid 文件后睡 600s(超时路径用)
//   noop         正常退出但不写任何产物(no_plan / no_result 路径用)
// 审查角色模式(W1b 工作流「主智能体」用):提示词不含 review-r<N>.json 锚点时视为 plan
// 阶段,一律写 plan.md 后退出;含锚点时视为审查阶段,按模式行事:
//   review_pass         写 review-r<N>.{md,json},verdict=pass
//   review_reject       verdict=reject + blocker issues(文本含轮次标记 r<N>);
//                       MOCK_REVIEW_PASS_FROM=<M> 时轮次 >= M 改判 pass(返工后通过场景)
//   review_bad_json     review-r<N>.json 写非法 JSON
//   review_bad_verdict  verdict 写 "maybe"(bad_review 路径)
//   review_none         审查阶段不写任何产物(no_review 路径)
//   review_hang         审查阶段写 pid 文件后睡 600s(timeout_review 路径)
//   review_modify       审查阶段越权改 cwd 文件,同时写 verdict=pass(review_modified 路径)
// 辅助环境变量:
//   MOCK_FILE             success 模式改动的文件名(默认 mock-output.txt)
//   MOCK_CONTENT          success 模式写入的内容(默认含 pid 的唯一串)
//   MOCK_WAIT_FILE        success 模式写完 plan.md 后轮询等待该文件出现再继续(制造合并竞态)
//   MOCK_REVIEW_PASS_FROM 见 review_reject
//   MOCK_DUMP_PROMPT      置 1 时把每次收到的完整提示词追加写入 <outDir>/mock-prompts.log

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

function parseArgs() {
  const args = process.argv.slice(2)
  const modeArg = args.find((a) => a.startsWith('--mock-mode='))
  const rest = args.filter((a) => !a.startsWith('--mock-mode='))
  return {
    mode: modeArg ? modeArg.slice('--mock-mode='.length) : process.env.MOCK_MODE || 'success',
    argPrompt: rest.length > 0 ? rest[rest.length - 1] : null
  }
}

function readPrompt(argPrompt) {
  if (argPrompt !== null) return argPrompt
  return fs.readFileSync(0, 'utf-8')
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function waitForFile(file) {
  const deadline = Date.now() + 30000
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) {
      console.error(`mock-agent: 等待 ${file} 超时`)
      process.exit(65)
    }
    sleepMs(50)
  }
}

function writePlan(outDir) {
  fs.writeFileSync(path.join(outDir, 'plan.md'), '# mock plan\n\n- 假设: 无\n- 步骤: 改一个文件\n')
}

function writeResult(outDir, body) {
  fs.writeFileSync(path.join(outDir, 'result.json'), body)
}

function hang(outDir) {
  fs.writeFileSync(path.join(outDir, 'mock.pid'), String(process.pid))
  setTimeout(() => {}, 600000)
}

function inGitWorktree(cwd) {
  try {
    const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return out.toString().trim() === 'true'
  } catch {
    return false
  }
}

function commitChange(cwd, file, content) {
  fs.writeFileSync(path.join(cwd, file), content + '\n')
  if (!inGitWorktree(cwd)) return
  execFileSync('git', ['add', '-A'], { cwd })
  execFileSync('git', ['commit', '-m', `mock: update ${file}`], { cwd })
}

/** 审查提示词锚点:wf-review 模板承诺的产物文件名 review-r<N>.json,N 即审查轮次 */
function reviewRoundOf(prompt) {
  const m = /review-r(\d+)\.json/.exec(prompt)
  return m ? Number(m[1]) : null
}

// 工作流主智能体角色:plan 阶段写 plan.md;审查阶段按 mode 产出判定
function reviewMain(mode, prompt, outDir, cwd) {
  const round = reviewRoundOf(prompt)
  if (round === null) return writePlan(outDir)

  if (mode === 'review_none') return
  if (mode === 'review_hang') return hang(outDir)
  const jsonFile = path.join(outDir, `review-r${round}.json`)
  if (mode === 'review_bad_json') return fs.writeFileSync(jsonFile, '{ not json !!!')
  if (mode === 'review_bad_verdict') {
    return fs.writeFileSync(jsonFile, JSON.stringify({ verdict: 'maybe', summary: 'mock 迷惑判定' }))
  }
  if (mode === 'review_modify') {
    fs.writeFileSync(path.join(cwd, 'review-tamper.txt'), 'reviewer went rogue\n')
  }
  const passFrom = process.env.MOCK_REVIEW_PASS_FROM
    ? Number(process.env.MOCK_REVIEW_PASS_FROM)
    : null
  const pass =
    mode === 'review_pass' ||
    mode === 'review_modify' ||
    (passFrom !== null && round >= passFrom)
  fs.writeFileSync(
    path.join(outDir, `review-r${round}.md`),
    `# mock review r${round}\n\nverdict: ${pass ? 'pass' : 'reject'}\n`
  )
  const body = pass
    ? { verdict: 'pass', summary: `mock 审查通过 r${round}`, issues: [] }
    : {
        verdict: 'reject',
        summary: `mock 审查不通过 r${round}`,
        issues: [
          {
            severity: 'blocker',
            desc: `mock-issue-r${round}: 实现与方案不符`,
            suggestion: `请修复标记 r${round}`
          }
        ]
      }
  fs.writeFileSync(jsonFile, JSON.stringify(body))
}

function main() {
  const { mode, argPrompt } = parseArgs()
  if (mode === 'nonzero_exit') process.exit(3)

  const prompt = readPrompt(argPrompt)
  const match = /^OUT_DIR:\s*(.+)\s*$/m.exec(prompt)
  if (!match) {
    console.error('mock-agent: 提示词中未找到 OUT_DIR 行')
    process.exit(64)
  }
  const outDir = match[1].trim()
  const cwd = process.cwd()
  console.log(`mock-agent: mode=${mode} cwd=${cwd} outDir=${outDir}`)
  if (process.env.MOCK_DUMP_PROMPT) {
    fs.appendFileSync(
      path.join(outDir, 'mock-prompts.log'),
      `\n===== mock prompt (mode=${mode}) =====\n${prompt}\n`
    )
  }

  if (mode === 'noop') return
  if (mode.startsWith('review_')) return reviewMain(mode, prompt, outDir, cwd)
  if (mode === 'hang') return hang(outDir)

  writePlan(outDir)
  if (mode === 'no_result') return
  if (mode === 'bad_json') return writeResult(outDir, '{ not json !!!')
  if (mode === 'fail_status') {
    return writeResult(outDir, JSON.stringify({ status: 'failed', summary: 'mock 故障' }))
  }

  if (process.env.MOCK_WAIT_FILE) waitForFile(process.env.MOCK_WAIT_FILE)
  const file = process.env.MOCK_FILE || 'mock-output.txt'
  const content = process.env.MOCK_CONTENT || `mock-${process.pid}-${Date.now()}`
  commitChange(cwd, file, content)
  writeResult(
    outDir,
    JSON.stringify({
      status: 'success',
      summary: `mock 完成,写入 ${file}`,
      files_changed: [file],
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString()
    })
  )
}

main()
