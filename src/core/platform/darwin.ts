import { execFile } from 'node:child_process'
import type { PlatformOps } from './index'

const KILL_GRACE_MS = 5000
const KILL_POLL_MS = 200

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

export const darwinOps: PlatformOps = {
  /** SIGTERM 整组 → 宽限期轮询 → SIGKILL 兜底 */
  async killTree(pid: number): Promise<void> {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      return // 进程组已不存在
    }
    const deadline = Date.now() + KILL_GRACE_MS
    while (Date.now() < deadline) {
      if (!groupAlive(pid)) return
      await new Promise((r) => setTimeout(r, KILL_POLL_MS))
    }
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // 宽限期内退净
    }
  },

  findBinary(name: string): Promise<string | null> {
    return new Promise((resolve) => {
      execFile('/usr/bin/which', [name], (err, stdout) => {
        if (err) return resolve(null)
        const found = stdout.trim()
        resolve(found.length > 0 ? found : null)
      })
    })
  },

  /** osascript 驱动 Terminal.app;首次调用触发系统自动化授权弹窗,拒绝时报错上抛 */
  openTerminal(cwd: string, command: string): Promise<void> {
    const shellCmd = `cd ${shellQuote(cwd)} && ${command}`
    const appleScriptString = shellCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    return new Promise((resolve, reject) => {
      execFile(
        '/usr/bin/osascript',
        [
          '-e',
          'tell application "Terminal" to activate',
          '-e',
          `tell application "Terminal" to do script "${appleScriptString}"`
        ],
        (err, _stdout, stderr) => {
          if (err) reject(new Error(`打开终端失败: ${stderr.trim() || err.message}`))
          else resolve()
        }
      )
    })
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
