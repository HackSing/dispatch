/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, process, console, setTimeout */
// 测试用 mock agent:纯 Node 脚本,不依赖仓库代码,由 MOCK_MODE 环境变量驱动行为。
// 通过 GenericCliAdapter 以 bin=process.execPath + headless_args=[本脚本] 方式喂入,
// 与真实 agent 走同一份适配器代码。OUT_DIR 从提示词的「OUT_DIR: <path>」行解析。
//
// MOCK_MODE:
//   success      写合法 plan.md + result.json,并在 cwd 改文件后 git add+commit(非 git 跳过)
//   no_result    只写 plan.md
//   bad_json     result.json 写非法内容
//   fail_status  result.json status=failed
//   nonzero_exit 直接以退出码 3 退出
//   hang         写 pid 文件后睡 600s(超时路径用)
// 辅助环境变量:
//   MOCK_FILE      success 模式改动的文件名(默认 mock-output.txt)
//   MOCK_CONTENT   success 模式写入的内容(默认含 pid 的唯一串)
//   MOCK_WAIT_FILE success 模式写完 plan.md 后轮询等待该文件出现再继续(制造合并竞态)

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

function readPrompt() {
  if (process.argv.length > 2) return process.argv[process.argv.length - 1]
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

function main() {
  const mode = process.env.MOCK_MODE || 'success'
  if (mode === 'nonzero_exit') process.exit(3)

  const prompt = readPrompt()
  const match = /^OUT_DIR:\s*(.+)\s*$/m.exec(prompt)
  if (!match) {
    console.error('mock-agent: 提示词中未找到 OUT_DIR 行')
    process.exit(64)
  }
  const outDir = match[1].trim()
  const cwd = process.cwd()
  console.log(`mock-agent: mode=${mode} cwd=${cwd} outDir=${outDir}`)

  if (mode === 'hang') {
    fs.writeFileSync(path.join(outDir, 'mock.pid'), String(process.pid))
    setTimeout(() => {}, 600000)
    return
  }

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
