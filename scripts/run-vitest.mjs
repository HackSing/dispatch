// vitest 跨平台启动器:替代 `ELECTRON_RUN_AS_NODE=1 electron ...` 的 POSIX env 前缀语法。
// 零依赖,仅用 node 内置模块;透传命令行参数与子进程退出码,darwin/win32 行为一致。
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
// electron npm 包导出其二进制绝对路径
const electronBin = require('electron')
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const child = spawn(
  electronBin,
  [path.join(projectRoot, 'node_modules', 'vitest', 'vitest.mjs'), 'run', ...process.argv.slice(2)],
  { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
)

child.on('error', (err) => {
  console.error(`run-vitest: 无法启动 electron: ${err.message}`)
  process.exitCode = 1
})

child.on('exit', (code, signal) => {
  if (signal) {
    // 子进程被信号终止:以同信号结束自身,保真 POSIX 语义
    process.kill(process.pid, signal)
    return
  }
  process.exitCode = code ?? 1
})
