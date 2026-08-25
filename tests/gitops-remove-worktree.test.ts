import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { branchExists, git, makeGitRepo } from './fixtures/git-repo'
import { createTaskWorktree, removeWorktree, GitError } from '@core/gitops'

/**
 * removeWorktree 的 win32 目录句柄锁实测形态回归(B5 批2,证据见 .kimi-report-b2.md 第4步):
 * 进程以 worktree 目录为 cwd 常驻时,`git worktree remove --force` 报
 * "failed to delete ... Permission denied"(exit 255)且登记已注销、目录残留。
 * 持锁手法与实测实验一致:子进程 cwd = worktree 根。仅 win32 可复现,darwin 自动跳过。
 * 定时放锁在满载套件下抖动,故一律等 holder 'exit' 确认句柄释放,不走 sleep 猜时。
 */

let home: string
let repo: string
let holder: ChildProcess | null = null

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dispatch-wtlock-home-'))
  repo = makeGitRepo('dispatch-wtlock-repo-')
})

afterEach(() => {
  if (holder && !holder.killed) holder.kill('SIGKILL')
  holder = null
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

async function makeWorktree(): Promise<{ worktreePath: string; branch: string }> {
  return createTaskWorktree({
    projectPath: repo,
    projectName: 'demo',
    worktreesDir: join(home, 'worktrees'),
    taskId: `lock-${Date.now()}`,
    taskText: '锁测试',
    baseBranch: 'main'
  })
}

/** 子进程以 worktree 根为 cwd 常驻 → Windows 锁死该目录句柄 */
function holdDir(dir: string): ChildProcess {
  holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: dir })
  return holder
}

/** 杀锁并等进程真正退出(句柄释放),消除时序猜测 */
async function releaseDir(): Promise<void> {
  if (!holder) return
  const exited = once(holder, 'exit')
  holder.kill('SIGKILL')
  await exited
}

describe.runIf(process.platform === 'win32')('removeWorktree win32 目录锁', () => {
  it('锁造成「注销+目录残留」中间态 → 放锁后单次调用补删残留,分支删除', async () => {
    const wt = await makeWorktree()
    holdDir(wt.worktreePath)
    await once(holder as ChildProcess, 'spawn')
    // 直接复现实测中间态:remove --force 报 Permission denied,登记被注销,目录残留
    expect(() => git(repo, ['worktree', 'remove', '--force', wt.worktreePath])).toThrow(
      /Permission denied/
    )
    expect(existsSync(wt.worktreePath)).toBe(true)
    await releaseDir()

    await expect(removeWorktree(repo, wt.worktreePath, wt.branch)).resolves.toBeUndefined()
    expect(existsSync(wt.worktreePath)).toBe(false)
    expect(branchExists(repo, wt.branch)).toBe(false)
  }, 15_000)

  it('锁持续超过重试预算 → 原样上抛 GitError(Permission denied),放锁后重入成功', async () => {
    const wt = await makeWorktree()
    holdDir(wt.worktreePath)
    await once(holder as ChildProcess, 'spawn')

    await expect(removeWorktree(repo, wt.worktreePath, wt.branch)).rejects.toThrow(GitError)
    // 放锁后重入(模拟用户再次点「清理」):残留目录被补删,分支清除
    await releaseDir()
    await expect(removeWorktree(repo, wt.worktreePath, wt.branch)).resolves.toBeUndefined()
    expect(existsSync(wt.worktreePath)).toBe(false)
    expect(branchExists(repo, wt.branch)).toBe(false)
  }, 20_000)
})
