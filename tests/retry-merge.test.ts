import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { retryMerge, runTask, Semaphore, KeyedLock, type ExecutorDeps } from '@core/executor'
import type { Project, Task } from '@shared/types'
import { branchExists, commitFile, git, headOf, makeDirty, makeGitRepo } from './fixtures/git-repo'

const MOCK_SCRIPT = fileURLToPath(new URL('./fixtures/mock-agent.cjs', import.meta.url))
const BUILTIN_PROMPTS_DIR = fileURLToPath(new URL('../resources/prompts', import.meta.url))
const MOCK_ENV_KEYS = ['MOCK_MODE', 'MOCK_FILE', 'MOCK_CONTENT', 'MOCK_WAIT_FILE']

let home: string
let repo: string
let paths: DispatchPaths
let db: Database
let projects: ProjectStore
let tasks: TaskStore
let changes: Task[]
let deps: ExecutorDeps

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dispatch-retry-'))
  repo = makeGitRepo()
  paths = resolvePaths(home)
  ensureDispatchDirs(paths)
  db = openDatabase(paths.dbFile)
  projects = new ProjectStore(db)
  changes = []
  tasks = new TaskStore(db, (t) => changes.push(t))
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
    taskTimeoutMs: 60_000,
    builtinPromptsDir: BUILTIN_PROMPTS_DIR
  }
})

afterEach(() => {
  for (const key of MOCK_ENV_KEYS) delete process.env[key]
  db.close()
  rmSync(home, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

function createProject(): Project {
  return projects.create({ name: 'demo', path: repo })
}

function createTask(projectId: string, text = 'retry merge task'): Task {
  return tasks.create({ text, projectId, agent: 'claude-code', triggerType: 'immediate' })
}

/** 模拟批次3 confirmPlan:awaiting_confirm→scheduled(暂停时字段已持久化) */
function confirm(taskId: string): void {
  tasks.transition(taskId, 'scheduled', {})
}

/** 单点完整两跑:首跑停 awaiting_confirm → 确认 → 执行跑到终态 */
async function planConfirmRun(task: Task): Promise<Task> {
  const paused = await runTask(deps, task.id)
  expect(paused.status).toBe('awaiting_confirm')
  confirm(task.id)
  return runTask(deps, task.id)
}

/** 造 awaiting_merge:主工作区脏 → 执行成功但不可安全合并 */
async function makeAwaitingMerge(project: Project): Promise<Task> {
  process.env.MOCK_MODE = 'success'
  makeDirty(repo)
  const task = createTask(project.id)
  const result = await planConfirmRun(task)
  expect(result.status).toBe('awaiting_merge')
  expect(result.failReason).toBe('base_dirty')
  return result
}

/** 造 conflict:方案跑建好 worktree 停在 awaiting_confirm 后,在 main 插入同文件冲突提交再确认放行 */
async function makeConflict(project: Project): Promise<Task> {
  process.env.MOCK_MODE = 'success'
  process.env.MOCK_FILE = 'file.txt'
  process.env.MOCK_CONTENT = 'from-task'
  const task = createTask(project.id, 'conflicting change task')
  const paused = await runTask(deps, task.id)
  expect(paused.status).toBe('awaiting_confirm')
  commitFile(repo, 'file.txt', 'from-main', 'conflicting change on main')
  confirm(task.id)
  const result = await runTask(deps, task.id)
  expect(result.status).toBe('conflict')
  return result
}

describe('retryMerge — awaiting_merge 起点', () => {
  it('主工作区恢复干净后重试 → done,base 推进,worktree 清理', async () => {
    const project = createProject()
    const task = await makeAwaitingMerge(project)
    const before = headOf(repo, 'main')
    git(repo, ['checkout', '--', 'file.txt'])

    const result = await retryMerge(deps, task.id)
    expect(result.status).toBe('done')
    expect(result.failReason).toBeNull()
    expect(result.mergedAt).toBeTruthy()
    expect(headOf(repo, 'main')).not.toBe(before)
    expect(readFileSync(join(repo, 'mock-output.txt'), 'utf-8')).toContain('mock-')
    expect(result.worktreePath).toBeNull()
    expect(existsSync(task.worktreePath as string)).toBe(false)
    expect(branchExists(repo, task.branch as string)).toBe(false)
    // merging 迁移清 failReason,最终态 done
    const merging = changes.find((c) => c.status === 'merging' && c.finishedAt !== null)
    expect(merging?.failReason).toBeNull()
    expect(changes[changes.length - 1].status).toBe('done')
  }, 20_000)

  it('主工作区仍脏 → 回到 awaiting_merge(base_dirty),下轮再试', async () => {
    const project = createProject()
    const task = await makeAwaitingMerge(project)

    const still = await retryMerge(deps, task.id)
    expect(still.status).toBe('awaiting_merge')
    expect(still.failReason).toBe('base_dirty')
    expect(existsSync(task.worktreePath as string)).toBe(true)

    git(repo, ['checkout', '--', 'file.txt'])
    const result = await retryMerge(deps, task.id)
    expect(result.status).toBe('done')
  }, 20_000)
})

describe('retryMerge — conflict 起点(手动)', () => {
  it('用户在 worktree 解决冲突并提交后重试 → done', async () => {
    const project = createProject()
    const task = await makeConflict(project)
    const wt = task.worktreePath as string
    // 模拟用户处理:在 worktree 里 merge main、解决冲突、提交
    expect(() => git(wt, ['merge', '--no-edit', 'main'])).toThrow()
    writeFileSync(join(wt, 'file.txt'), 'resolved\n')
    git(wt, ['add', '-A'])
    git(wt, ['commit', '-m', 'resolve conflict'])

    const result = await retryMerge(deps, task.id)
    expect(result.status).toBe('done')
    expect(result.failReason).toBeNull()
    expect(readFileSync(join(repo, 'file.txt'), 'utf-8')).toBe('resolved\n')
    expect(existsSync(wt)).toBe(false)
    expect(branchExists(repo, task.branch as string)).toBe(false)
  }, 30_000)

  it('未解决就重试且 base 又有新冲突提交 → 仍 conflict,报告重新生成', async () => {
    const project = createProject()
    const task = await makeConflict(project)
    commitFile(repo, 'file.txt', 'from-main-again', 'second conflicting change on main')

    const result = await retryMerge(deps, task.id)
    expect(result.status).toBe('conflict')
    expect(existsSync(task.worktreePath as string)).toBe(true)
    const report = readFileSync(join(task.archiveDir as string, 'conflict-report.md'), 'utf-8')
    expect(report).toContain('second conflicting change on main')
  }, 30_000)
})

describe('retryMerge — 边界', () => {
  it('worktree 路径未入库(恢复未回填)→ failed(worktree_missing)', async () => {
    const project = createProject()
    const task = createTask(project.id)
    tasks.transition(task.id, 'running', { baseBranch: 'main' })
    tasks.transition(task.id, 'merging')
    tasks.transition(task.id, 'awaiting_merge', { failReason: 'base_dirty' })

    const result = await retryMerge(deps, task.id)
    expect(result.status).toBe('failed')
    expect(result.failReason).toBe('worktree_missing')
    expect(result.finishedAt).toBeTruthy()
  })

  it('worktree 目录已被删除 → failed(worktree_missing)', async () => {
    const project = createProject()
    const task = await makeAwaitingMerge(project)
    rmSync(task.worktreePath as string, { recursive: true, force: true })

    const result = await retryMerge(deps, task.id)
    expect(result.status).toBe('failed')
    expect(result.failReason).toBe('worktree_missing')
  }, 20_000)

  it('起点状态非 awaiting_merge/conflict → 抛错拒绝', async () => {
    const project = createProject()
    const task = createTask(project.id)
    await expect(retryMerge(deps, task.id)).rejects.toThrow(/不可重试合并/)
    await expect(retryMerge(deps, 'no-such-id')).rejects.toThrow(/任务不存在/)
  })
})
