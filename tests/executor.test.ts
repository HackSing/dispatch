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
import { runTask, Semaphore, KeyedLock, type ExecutorDeps } from '@core/executor'
import { sanitizeName, shortId } from '@core/naming'
import type { Project, Task } from '@shared/types'
import { branchExists, commitFile, git, headOf, makeDirty, makeGitRepo } from './fixtures/git-repo'

const MOCK_SCRIPT = fileURLToPath(new URL('./fixtures/mock-agent.cjs', import.meta.url))
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
  home = mkdtempSync(join(tmpdir(), 'dispatch-home-'))
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
    taskTimeoutMs: 60_000
  }
})

afterEach(() => {
  for (const key of MOCK_ENV_KEYS) delete process.env[key]
  db.close()
  rmSync(home, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

function createProject(overrides: Partial<Parameters<ProjectStore['create']>[0]> = {}): Project {
  return projects.create({ name: 'demo', path: repo, ...overrides })
}

function createTask(projectId: string, text = 'fix the login bug'): Task {
  return tasks.create({ text, projectId, agent: 'claude-code', triggerType: 'immediate' })
}

function localDate(d = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function archiveDirOf(project: Project, task: Task): string {
  return join(paths.archivesDir, sanitizeName(project.name), `${localDate()}-${shortId(task.id)}`)
}

function worktreeDirOf(project: Project, task: Task): string {
  return join(paths.worktreesDir, sanitizeName(project.name), task.id)
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('runTask 八条路径', () => {
  it('① 成功执行 + 干净合并 → done,base 推进,worktree 清理', async () => {
    process.env.MOCK_MODE = 'success'
    process.env.MOCK_CONTENT = 'from-success'
    const project = createProject()
    const task = createTask(project.id)
    const before = headOf(repo, 'main')

    const result = await runTask(deps, task.id)

    expect(result.status).toBe('done')
    expect(result.failReason).toBeNull()
    expect(result.baseBranch).toBe('main')
    expect(result.startedAt).toBeTruthy()
    expect(result.finishedAt).toBeTruthy()
    expect(result.mergedAt).toBeTruthy()
    expect(changes.map((c) => c.status)).toEqual(['scheduled', 'running', 'merging', 'done'])
    // base 分支推进且主工作区拿到产出
    expect(headOf(repo, 'main')).not.toBe(before)
    expect(readFileSync(join(repo, 'mock-output.txt'), 'utf-8')).toBe('from-success\n')
    // 归档齐全
    const archive = archiveDirOf(project, task)
    expect(result.archiveDir).toBe(archive)
    for (const f of ['task.md', 'plan.md', 'result.json', 'output.log']) {
      expect(existsSync(join(archive, f)), f).toBe(true)
    }
    expect(readFileSync(join(archive, 'task.md'), 'utf-8')).toContain('vcs: git')
    expect(readFileSync(join(archive, 'output.log'), 'utf-8')).toContain('mock-agent:')
    // worktree 与分支已清理
    expect(result.worktreePath).toBeNull()
    expect(existsSync(worktreeDirOf(project, task))).toBe(false)
    expect(result.branch).toMatch(/^task\/[0-9a-f]{8}-fix-the-login/)
    expect(branchExists(repo, result.branch as string)).toBe(false)
  })

  it('② 并行修改同区域 → conflict + 报告生成 + worktree 保留', async () => {
    process.env.MOCK_MODE = 'success'
    const project = createProject()
    // 任务 A 先落地一版 file.txt
    process.env.MOCK_FILE = 'file.txt'
    process.env.MOCK_CONTENT = 'from-A'
    const taskA = createTask(project.id, 'task a rewrite file')
    await runTask(deps, taskA.id)
    // 任务 B 建完 worktree 后(plan.md 出现),base 上再插入一笔冲突提交
    const gate = join(home, 'gate')
    process.env.MOCK_CONTENT = 'from-B'
    process.env.MOCK_WAIT_FILE = gate
    const taskB = createTask(project.id, 'task b rewrite file')
    const pending = runTask(deps, taskB.id)
    const planB = join(archiveDirOf(project, taskB), 'plan.md')
    await waitFor(() => existsSync(planB))
    commitFile(repo, 'file.txt', 'from-main', 'conflicting change on main')
    const baseHead = headOf(repo, 'main')
    writeFileSync(gate, '')

    const result = await pending
    expect(result.status).toBe('conflict')
    // base 未被推进,主工作区内容未动
    expect(headOf(repo, 'main')).toBe(baseHead)
    expect(readFileSync(join(repo, 'file.txt'), 'utf-8')).toBe('from-main\n')
    // worktree 与分支保留,worktree 内 merge 已 abort(无残留 MERGE_HEAD)
    const wt = worktreeDirOf(project, taskB)
    expect(result.worktreePath).toBe(wt)
    expect(existsSync(wt)).toBe(true)
    expect(branchExists(repo, result.branch as string)).toBe(true)
    expect(() => git(wt, ['rev-parse', '--verify', 'MERGE_HEAD'])).toThrow()
    // 冲突报告
    const report = readFileSync(join(archiveDirOf(project, taskB), 'conflict-report.md'), 'utf-8')
    expect(report).toContain('file.txt')
    expect(report).toContain('mock: update file.txt')
    expect(report).toContain('conflicting change on main')
    expect(report).toContain(wt)
  }, 20_000)

  it('③ 缺 result.json → failed: no_result,worktree 保留', async () => {
    process.env.MOCK_MODE = 'no_result'
    const project = createProject()
    const task = createTask(project.id)
    const before = headOf(repo, 'main')

    const result = await runTask(deps, task.id)
    expect(result.status).toBe('failed')
    expect(result.failReason).toBe('no_result')
    expect(existsSync(join(archiveDirOf(project, task), 'plan.md'))).toBe(true)
    expect(existsSync(join(archiveDirOf(project, task), 'result.json'))).toBe(false)
    expect(existsSync(worktreeDirOf(project, task))).toBe(true)
    expect(headOf(repo, 'main')).toBe(before)
  })

  it('④ 非法 JSON → failed: bad_result', async () => {
    process.env.MOCK_MODE = 'bad_json'
    const project = createProject()
    const task = createTask(project.id)

    const result = await runTask(deps, task.id)
    expect(result.status).toBe('failed')
    expect(result.failReason).toBe('bad_result')
    expect(existsSync(worktreeDirOf(project, task))).toBe(true)
  })

  it('⑤ 超时 → failed: timeout,进程组已死', async () => {
    process.env.MOCK_MODE = 'hang'
    deps.taskTimeoutMs = 2000
    const project = createProject()
    const task = createTask(project.id)

    const result = await runTask(deps, task.id)
    expect(result.status).toBe('failed')
    expect(result.failReason).toBe('timeout')
    expect(result.finishedAt).toBeTruthy()
    const pid = Number(readFileSync(join(archiveDirOf(project, task), 'mock.pid'), 'utf-8'))
    expect(pid).toBeGreaterThan(0)
    await waitFor(() => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    }, 6000)
    expect(existsSync(worktreeDirOf(project, task))).toBe(true)
  }, 15_000)

  it('⑥ prepare_cmd 失败 → failed: prepare_failed', async () => {
    process.env.MOCK_MODE = 'success'
    // prepare_cmd 走系统 shell,分隔符语法按平台各写一份(POSIX `;` / cmd `&`,参照批1 detection.test.ts)
    const prepareCmd =
      process.platform === 'win32'
        ? 'echo prepare-boom 1>&2 & exit 7'
        : 'echo prepare-boom >&2; exit 7'
    const project = createProject({ prepareCmd })
    const task = createTask(project.id)

    const result = await runTask(deps, task.id)
    expect(result.status).toBe('failed')
    expect(result.failReason).toBe('prepare_failed')
    expect(readFileSync(join(archiveDirOf(project, task), 'output.log'), 'utf-8')).toContain(
      'prepare-boom'
    )
    expect(existsSync(worktreeDirOf(project, task))).toBe(true)
  })

  it('⑦ 主工作区在 base 且脏 → awaiting_merge,worktree 保留', async () => {
    process.env.MOCK_MODE = 'success'
    makeDirty(repo)
    const project = createProject()
    const task = createTask(project.id)
    const before = headOf(repo, 'main')

    const result = await runTask(deps, task.id)
    expect(result.status).toBe('awaiting_merge')
    expect(result.failReason).toBe('base_dirty')
    expect(headOf(repo, 'main')).toBe(before)
    expect(existsSync(worktreeDirOf(project, task))).toBe(true)
    expect(branchExists(repo, result.branch as string)).toBe(true)
    // 用户脏区未被触碰,任务产物没有落进主工作区
    expect(readFileSync(join(repo, 'file.txt'), 'utf-8')).toBe('dirty uncommitted change\n')
    expect(existsSync(join(repo, 'mock-output.txt'))).toBe(false)
  })

  it('⑧ 非 git 项目 → done,归档标 no_vcs', async () => {
    process.env.MOCK_MODE = 'success'
    const plainDir = mkdtempSync(join(tmpdir(), 'dispatch-plain-'))
    try {
      const project = createProject({ name: 'plain', path: plainDir })
      const task = createTask(project.id)

      const result = await runTask(deps, task.id)
      expect(result.status).toBe('done')
      expect(result.baseBranch).toBeNull()
      expect(result.branch).toBeNull()
      expect(result.worktreePath).toBeNull()
      expect(result.mergedAt).toBeNull()
      const archive = archiveDirOf(project, task)
      expect(readFileSync(join(archive, 'task.md'), 'utf-8')).toContain('vcs: no_vcs')
      expect(existsSync(join(archive, 'plan.md'))).toBe(true)
      expect(existsSync(join(archive, 'result.json'))).toBe(true)
      // 非 git:直接在项目目录产出,mock 跳过 commit
      expect(readFileSync(join(plainDir, 'mock-output.txt'), 'utf-8')).toContain('mock-')
    } finally {
      rmSync(plainDir, { recursive: true, force: true })
    }
  })
})

describe('runTask 补充路径', () => {
  it('base 未被任何 worktree 检出 → update-ref 推进,主工作区不动', async () => {
    process.env.MOCK_MODE = 'success'
    git(repo, ['checkout', '-b', 'other'])
    const project = createProject({ baseBranch: 'main' })
    const task = createTask(project.id)
    const before = headOf(repo, 'main')

    const result = await runTask(deps, task.id)
    expect(result.status).toBe('done')
    expect(headOf(repo, 'main')).not.toBe(before)
    // 主工作区仍在 other,工作区文件未被触碰
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('other')
    expect(existsSync(join(repo, 'mock-output.txt'))).toBe(false)
    expect(existsSync(worktreeDirOf(project, task))).toBe(false)
    expect(branchExists(repo, result.branch as string)).toBe(false)
  })

  it('result.json status=failed → failed: result_failed', async () => {
    process.env.MOCK_MODE = 'fail_status'
    const project = createProject()
    const task = createTask(project.id)
    const result = await runTask(deps, task.id)
    expect(result.status).toBe('failed')
    expect(result.failReason).toBe('result_failed')
  })

  it('agent 非零退出 → failed: exit_3', async () => {
    process.env.MOCK_MODE = 'nonzero_exit'
    const project = createProject()
    const task = createTask(project.id)
    const result = await runTask(deps, task.id)
    expect(result.status).toBe('failed')
    expect(result.failReason).toBe('exit_3')
  })

  it('非 scheduled 状态拒绝执行', async () => {
    const project = createProject()
    const task = tasks.create({ text: 'todo', projectId: project.id, triggerType: 'none' })
    await expect(runTask(deps, task.id)).rejects.toThrow(/不可执行/)
  })
})
