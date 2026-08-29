import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openDatabase, ProjectStore, TaskStore } from '@core/db'
import { AgentConfigSchema, loadConfig } from '@core/config'
import { ensureDispatchDirs, resolvePaths, type DispatchPaths } from '@core/paths'
import { getPlatformOps } from '@core/platform'
import { GenericCliAdapter } from '@core/agents/generic-cli-adapter'
import { runTask, Semaphore, KeyedLock, type ExecutorDeps } from '@core/executor'
import { TaskCancellations } from '@core/executor/locks'
import { rerunFailedTask } from '@core/task-edit'
import { makeGitRepo } from './fixtures/git-repo'

const MOCK_SCRIPT = fileURLToPath(new URL('./fixtures/mock-agent.cjs', import.meta.url))
const BUILTIN_PROMPTS_DIR = fileURLToPath(new URL('../resources/prompts', import.meta.url))

let home: string
let repo: string
let paths: DispatchPaths
let db: Database
let projects: ProjectStore
let tasks: TaskStore
let cancellations: TaskCancellations
let deps: ExecutorDeps

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dispatch-int-home-'))
  repo = makeGitRepo()
  paths = resolvePaths(home)
  ensureDispatchDirs(paths)
  db = openDatabase(paths.dbFile)
  projects = new ProjectStore(db)
  tasks = new TaskStore(db)
  cancellations = new TaskCancellations()
  const adapter = new GenericCliAdapter(
    'claude-code',
    AgentConfigSchema.parse({ bin: process.execPath, headless_args: [MOCK_SCRIPT] }),
    getPlatformOps()
  )
  deps = {
    tasks,
    projects,
    config: loadConfig(paths.configFile),
    paths,
    adapterFor: () => adapter,
    semaphore: new Semaphore(2),
    mergeLocks: new KeyedLock(),
    cancellations,
    taskTimeoutMs: 60_000,
    builtinPromptsDir: BUILTIN_PROMPTS_DIR
  }
})

afterEach(() => {
  delete process.env.MOCK_MODE
  db.close()
  rmSync(home, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('用户中断', () => {
  it('运行中中断 → failed(user_interrupted),worktree 保留,可原地重跑', { timeout: 30_000 }, async () => {
    process.env.MOCK_MODE = 'hang'
    const project = projects.create({ name: 'demo', path: repo })
    const task = tasks.create({
      text: '会挂起的任务',
      projectId: project.id,
      agent: 'claude-code',
      triggerType: 'immediate'
    })
    const running = runTask(deps, task.id)
    // mock hang 模式在归档目录写 pid 文件后长睡:等它就位再中断,避免竞态
    const worktree = join(paths.worktreesDir, 'demo', task.id)
    const archiveRoot = join(paths.archivesDir, 'demo')
    const pidVisible = (): boolean =>
      existsSync(archiveRoot) &&
      readdirSync(archiveRoot).some((d) => existsSync(join(archiveRoot, d, 'mock.pid')))
    await waitFor(pidVisible)
    expect(cancellations.interrupt(task.id)).toBe(true)
    const finished = await running
    expect(finished).toMatchObject({ status: 'failed', failReason: 'user_interrupted' })
    expect(existsSync(worktree)).toBe(true)

    // 中断后原地重跑:同一任务行回到 scheduled,worktree 已清理
    process.env.MOCK_MODE = 'success'
    const rerun = await rerunFailedTask({ tasks, projects }, task.id)
    expect(rerun).toMatchObject({ id: task.id, status: 'scheduled', failReason: null })
    expect(existsSync(worktree)).toBe(false)
    // 两跑:方案跑停 awaiting_confirm → 确认 → 执行跑合并 done
    const paused = await runTask(deps, task.id)
    expect(paused.status).toBe('awaiting_confirm')
    tasks.transition(task.id, 'scheduled', {})
    const done = await runTask(deps, task.id)
    expect(done.status).toBe('done')
  })

  it('无在途 agent 运行时 interrupt 返回 false', () => {
    expect(cancellations.interrupt('nonexistent')).toBe(false)
  })
})
