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
  }
}
