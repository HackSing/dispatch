import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openDatabase, TaskStore, ProjectStore } from '@core/db'
import { createTaskWorktree } from '@core/gitops'
import { cleanupTaskWorkspace } from '@core/executor/cleanup'
import { abandonTask } from '@core/task-edit'
import { git, makeGitRepo } from './fixtures/git-repo'

/** failed 终态的 worktree/分支清理闭环(用户需求:任务确认完成/放弃后不留残留) */

let dir: string
let db: Database
let tasks: TaskStore
let projects: ProjectStore
let repo: string
let projectId: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dispatch-cleanup-'))
  db = openDatabase(join(dir, 'test.db'))
  tasks = new TaskStore(db)
  projects = new ProjectStore(db)
  repo = makeGitRepo('dispatch-cleanup-repo-')
  projectId = projects.create({ name: 'demo', path: repo }).id
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

async function makeTaskWithWorktree(status: 'failed' | 'conflict'): Promise<{
  id: string
  worktreePath: string
  branch: string
}> {
  const task = tasks.create({
    text: '清理测试',
    projectId,
    agent: 'claude-code',
    triggerType: 'immediate'
  })
  const wt = await createTaskWorktree({
    projectPath: repo,
    projectName: 'demo',
    worktreesDir: join(dir, 'worktrees'),
    taskId: task.id,
    taskText: task.text,
    baseBranch: 'main'
  })
  tasks.transition(task.id, 'running', {
    worktreePath: wt.worktreePath,
    branch: wt.branch,
    baseBranch: 'main'
  })
  if (status === 'failed') {
    tasks.transition(task.id, 'failed', { failReason: 'timeout' })
  } else {
    tasks.transition(task.id, 'merging')
    tasks.transition(task.id, 'conflict', { failReason: null })
  }
  return { id: task.id, worktreePath: wt.worktreePath, branch: wt.branch }
}

function branchExists(branch: string): boolean {
  // fixtures.git 是同步封装,断言用
  return git(repo, ['branch', '--list', branch]).trim().length > 0
}

describe('cleanupTaskWorkspace', () => {
  it('failed 任务:worktree 目录与分支删除,db 路径清空,分支名保留', async () => {
    const t = await makeTaskWithWorktree('failed')
    expect(existsSync(t.worktreePath)).toBe(true)
    const cleaned = await cleanupTaskWorkspace({ tasks, projects }, t.id)
    expect(existsSync(t.worktreePath)).toBe(false)
    expect(branchExists(t.branch)).toBe(false)
    expect(cleaned.worktreePath).toBeNull()
    expect(cleaned.branch).toBe(t.branch)
  })

  it('放弃组合:conflict → abandon → 清理,与 handler 编排一致', async () => {
    const t = await makeTaskWithWorktree('conflict')
    abandonTask(tasks, t.id)
    const cleaned = await cleanupTaskWorkspace({ tasks, projects }, t.id)
    expect(cleaned.status).toBe('failed')
    expect(cleaned.failReason).toBe('abandoned')
    expect(existsSync(t.worktreePath)).toBe(false)
    expect(branchExists(t.branch)).toBe(false)
  })

  it('conflict 状态拒绝清理(worktree 是重试合并的前提)', async () => {
    const t = await makeTaskWithWorktree('conflict')
    await expect(cleanupTaskWorkspace({ tasks, projects }, t.id)).rejects.toThrow(/仅 failed/)
    expect(existsSync(t.worktreePath)).toBe(true)
  })

  it('worktree 目录已在盘外消失:prune 登记并删分支,可重入', async () => {
    const t = await makeTaskWithWorktree('failed')
    rmSync(t.worktreePath, { recursive: true, force: true })
    const cleaned = await cleanupTaskWorkspace({ tasks, projects }, t.id)
    expect(branchExists(t.branch)).toBe(false)
    expect(cleaned.worktreePath).toBeNull()
    // 再清一次为 no-op
    await cleanupTaskWorkspace({ tasks, projects }, t.id)
  })

  it('无 worktree 的 failed 任务为 no-op', async () => {
    const task = tasks.create({
      text: 'x',
      projectId,
      agent: 'claude-code',
      triggerType: 'immediate'
    })
    tasks.transition(task.id, 'running')
    tasks.transition(task.id, 'failed', { failReason: 'no_plan' })
    const cleaned = await cleanupTaskWorkspace({ tasks, projects }, task.id)
    expect(cleaned.worktreePath).toBeNull()
  })

  it('clearWorktreePath 仅 failed 允许', async () => {
    const t = await makeTaskWithWorktree('conflict')
    expect(() => tasks.clearWorktreePath(t.id)).toThrow(/不允许清空/)
  })
})
