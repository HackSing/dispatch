import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
import { confirmPlan, runTask, Semaphore, KeyedLock, type ExecutorDeps } from '@core/executor'
import { cleanupTaskWorkspace } from '@core/executor/cleanup'
import { abandonTask } from '@core/task-edit'
import { sanitizeName, shortId } from '@core/naming'
import type { Project, Task } from '@shared/types'
import { branchExists, commitFile, git, headOf, makeDirty, makeGitRepo } from './fixtures/git-repo'

const MOCK_SCRIPT = fileURLToPath(new URL('./fixtures/mock-agent.cjs', import.meta.url))
// 方案确认闸两跑:单点 default-plan.md/default-exec.md 与 wf-*.md 同走 builtinPromptsDir 解析
const BUILTIN_PROMPTS_DIR = fileURLToPath(new URL('../resources/prompts', import.meta.url))
const MOCK_ENV_KEYS = ['MOCK_MODE', 'MOCK_FILE', 'MOCK_CONTENT', 'MOCK_WAIT_FILE', 'MOCK_DUMP_PROMPT']

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

/** 折叠连续同状态(setPhase 会产生多次 running 广播),留下状态迁移主干供断言 */
function statusTrail(): string[] {
  const out: string[] = []
  for (const c of changes) if (out[out.length - 1] !== c.status) out.push(c.status)
  return out
}

/** 模拟批次3 confirmPlan:awaiting_confirm→scheduled(暂停时字段已持久化,空 patch 保留) */
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

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('runTask 八条路径(方案确认闸两跑)', () => {
  it('① 首跑停 awaiting_confirm,确认后执行 + 干净合并 → done,base 推进,worktree 清理', async () => {
    process.env.MOCK_MODE = 'success'
    process.env.MOCK_CONTENT = 'from-success'
    const project = createProject()
    const task = createTask(project.id)
    const before = headOf(repo, 'main')

    // 方案跑:停在 awaiting_confirm,字段持久化,plan.md 已落盘但无 result.json、未合并
    const paused = await runTask(deps, task.id)
    expect(paused.status).toBe('awaiting_confirm')
    expect(paused.phase).toBe('plan')
    expect(paused.archiveDir).toBe(archiveDirOf(project, task))
    expect(paused.worktreePath).toBe(worktreeDirOf(project, task))
    expect(paused.branch).toMatch(/^task\/[0-9a-f]{8}-fix-the-login/)
    expect(existsSync(join(paused.archiveDir as string, 'plan.md'))).toBe(true)
    expect(existsSync(join(paused.archiveDir as string, 'result.json'))).toBe(false)
    expect(headOf(repo, 'main')).toBe(before)
    expect(existsSync(join(repo, 'mock-output.txt'))).toBe(false)

    // 确认放行 → 执行跑合并
    confirm(task.id)
    const result = await runTask(deps, task.id)

    expect(result.status).toBe('done')
    expect(result.failReason).toBeNull()
    expect(result.baseBranch).toBe('main')
    expect(result.startedAt).toBeTruthy()
    expect(result.finishedAt).toBeTruthy()
    expect(result.mergedAt).toBeTruthy()
    expect(result.phase).toBeNull()
    expect(statusTrail()).toEqual([
      'scheduled',
      'running',
      'awaiting_confirm',
      'scheduled',
      'running',
      'merging',
      'done'
    ])
    // base 分支推进且主工作区拿到产出
    expect(headOf(repo, 'main')).not.toBe(before)
    expect(readFileSync(join(repo, 'mock-output.txt'), 'utf-8')).toBe('from-success\n')
    // 归档齐全(执行跑复用方案跑归档)
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
  }, 20_000)

  it('② 确认前 base 抢跑冲突提交 → 确认后合并 conflict + 报告 + worktree 保留', async () => {
    process.env.MOCK_MODE = 'success'
    const project = createProject()
    // 任务 A 先落地一版 file.txt(完整两跑)
    process.env.MOCK_FILE = 'file.txt'
    process.env.MOCK_CONTENT = 'from-A'
    const taskA = createTask(project.id, 'task a rewrite file')
    await planConfirmRun(taskA)
    // 任务 B:方案跑从 A 之后的 main 切出 worktree 并停在 awaiting_confirm
    process.env.MOCK_CONTENT = 'from-B'
    const taskB = createTask(project.id, 'task b rewrite file')
    const pausedB = await runTask(deps, taskB.id)
    expect(pausedB.status).toBe('awaiting_confirm')
    // 确认放行前,base 上插入一笔冲突提交(awaiting_confirm 断点即天然竞态注入点)
    commitFile(repo, 'file.txt', 'from-main', 'conflicting change on main')
    const baseHead = headOf(repo, 'main')

    confirm(taskB.id)
    const result = await runTask(deps, taskB.id)

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
  }, 25_000)

  it('③ 执行跑缺 result.json → failed: no_result,worktree 保留', async () => {
    process.env.MOCK_MODE = 'no_result'
    const project = createProject()
    const task = createTask(project.id)
    const before = headOf(repo, 'main')

    const result = await planConfirmRun(task)
    expect(result.status).toBe('failed')
    expect(result.failReason).toBe('no_result')
    expect(existsSync(join(archiveDirOf(project, task), 'plan.md'))).toBe(true)
    expect(existsSync(join(archiveDirOf(project, task), 'result.json'))).toBe(false)
    expect(existsSync(worktreeDirOf(project, task))).toBe(true)
    expect(headOf(repo, 'main')).toBe(before)
  }, 20_000)

  it('④ 执行跑非法 JSON → failed: bad_result', async () => {
    process.env.MOCK_MODE = 'bad_json'
    const project = createProject()
    const task = createTask(project.id)

    const result = await planConfirmRun(task)
    expect(result.status).toBe('failed')
    expect(result.failReason).toBe('bad_result')
    expect(existsSync(worktreeDirOf(project, task))).toBe(true)
  }, 20_000)

  it('⑤ 方案跑超时 → failed: timeout,进程组已死', async () => {
    process.env.MOCK_MODE = 'hang'
    deps.taskTimeoutMs = 2000
    const project = createProject()
    const task = createTask(project.id)

    // hang 在方案跑即超时,不到 awaiting_confirm
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

  it('⑥ prepare_cmd 失败 → failed: prepare_failed(方案跑前失败)', async () => {
    process.env.MOCK_MODE = 'success'
    // prepare_cmd 走系统 shell,分隔符语法按平台各写一份(POSIX `;` / cmd `&`)
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

  it('⑦ 主工作区在 base 且脏 → 确认后合并 awaiting_merge,worktree 保留', async () => {
    process.env.MOCK_MODE = 'success'
    makeDirty(repo)
    const project = createProject()
    const task = createTask(project.id)
    const before = headOf(repo, 'main')

    const result = await planConfirmRun(task)
    expect(result.status).toBe('awaiting_merge')
    expect(result.failReason).toBe('base_dirty')
    expect(headOf(repo, 'main')).toBe(before)
    expect(existsSync(worktreeDirOf(project, task))).toBe(true)
    expect(branchExists(repo, result.branch as string)).toBe(true)
    // 用户脏区未被触碰,任务产物没有落进主工作区
    expect(readFileSync(join(repo, 'file.txt'), 'utf-8')).toBe('dirty uncommitted change\n')
    expect(existsSync(join(repo, 'mock-output.txt'))).toBe(false)
  }, 20_000)

  it('⑧ 非 git 项目 → 确认后 done,归档标 no_vcs', async () => {
    process.env.MOCK_MODE = 'success'
    const plainDir = mkdtempSync(join(tmpdir(), 'dispatch-plain-'))
    try {
      const project = createProject({ name: 'plain', path: plainDir })
      const task = createTask(project.id)

      const result = await planConfirmRun(task)
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
  }, 20_000)
})

describe('runTask 补充路径', () => {
  it('base 未被任何 worktree 检出 → update-ref 推进,主工作区不动', async () => {
    process.env.MOCK_MODE = 'success'
    git(repo, ['checkout', '-b', 'other'])
    const project = createProject({ baseBranch: 'main' })
    const task = createTask(project.id)
    const before = headOf(repo, 'main')

    const result = await planConfirmRun(task)
    expect(result.status).toBe('done')
    expect(headOf(repo, 'main')).not.toBe(before)
    // 主工作区仍在 other,工作区文件未被触碰
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('other')
    expect(existsSync(join(repo, 'mock-output.txt'))).toBe(false)
    expect(existsSync(worktreeDirOf(project, task))).toBe(false)
    expect(branchExists(repo, result.branch as string)).toBe(false)
  }, 20_000)

  it('执行跑 result.json status=failed → failed: result_failed', async () => {
    process.env.MOCK_MODE = 'fail_status'
    const project = createProject()
    const task = createTask(project.id)
    const result = await planConfirmRun(task)
    expect(result.status).toBe('failed')
    expect(result.failReason).toBe('result_failed')
  }, 20_000)

  it('方案跑 agent 非零退出 → failed: exit_3', async () => {
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

describe('方案确认闸两跑:重入、连跑与回退', () => {
  it('两跑分别渲染 default-plan.md 与 default-exec.md', async () => {
    process.env.MOCK_MODE = 'success'
    process.env.MOCK_DUMP_PROMPT = '1'
    const project = createProject()
    const task = createTask(project.id)

    const paused = await runTask(deps, task.id)
    confirm(task.id)
    await runTask(deps, task.id)

    // 两跑提示词都追加进同一归档的 mock-prompts.log(执行跑复用方案跑归档)
    const prompts = readFileSync(join(paused.archiveDir as string, 'mock-prompts.log'), 'utf-8')
    expect(prompts).toContain('方案阶段') // default-plan.md 标题
    expect(prompts).toContain('等待用户确认') // 方案跑独有锚点
    expect(prompts).toContain('执行阶段') // default-exec.md 标题
    expect(prompts).toContain('已经用户确认') // 执行跑锚点
  }, 20_000)

  it('连跑兼容:方案跑已写 result.json → 不暂停,按旧语义合并 done', async () => {
    process.env.MOCK_MODE = 'connect'
    const project = createProject()
    const task = createTask(project.id)

    const result = await runTask(deps, task.id)
    expect(result.status).toBe('done')
    expect(result.failReason).toBeNull()
    expect(result.phase).toBeNull()
    // 未经 awaiting_confirm:状态直达 running→merging→done
    expect(statusTrail()).toEqual(['scheduled', 'running', 'merging', 'done'])
    const archive = archiveDirOf(project, task)
    expect(existsSync(join(archive, 'plan.md'))).toBe(true)
    expect(existsSync(join(archive, 'result.json'))).toBe(true)
  }, 20_000)

  it('确认重入但 plan.md 已被删 → 回退完整首跑(再次停 awaiting_confirm,归档换新)', async () => {
    process.env.MOCK_MODE = 'success'
    const plainDir = mkdtempSync(join(tmpdir(), 'dispatch-plain-'))
    try {
      const project = createProject({ name: 'plain', path: plainDir })
      const task = createTask(project.id)

      const paused = await runTask(deps, task.id)
      expect(paused.status).toBe('awaiting_confirm')
      const firstArchive = paused.archiveDir as string
      // 用户删除方案产物后确认
      rmSync(join(firstArchive, 'plan.md'))
      confirm(task.id)

      const rerun = await runTask(deps, task.id)
      // 回退完整首跑:再次产出方案并停 awaiting_confirm,归档换新目录
      expect(rerun.status).toBe('awaiting_confirm')
      expect(rerun.phase).toBe('plan')
      expect(rerun.archiveDir).not.toBe(firstArchive)
      expect(existsSync(join(rerun.archiveDir as string, 'plan.md'))).toBe(true)
    } finally {
      rmSync(plainDir, { recursive: true, force: true })
    }
  }, 20_000)

  it('单点确认重入用 default-exec.md 完成执行(no_vcs)→ done', async () => {
    process.env.MOCK_MODE = 'success'
    process.env.MOCK_DUMP_PROMPT = '1'
    const plainDir = mkdtempSync(join(tmpdir(), 'dispatch-plain-'))
    try {
      const project = createProject({ name: 'plain', path: plainDir })
      const task = createTask(project.id)

      const paused = await runTask(deps, task.id)
      expect(paused.status).toBe('awaiting_confirm')
      confirm(task.id)
      const result = await runTask(deps, task.id)

      expect(result.status).toBe('done')
      expect(result.phase).toBeNull()
      // 执行跑用了 default-exec.md(非 default-plan.md)
      const log = readFileSync(join(result.archiveDir as string, 'output.log'), 'utf-8')
      expect(log).toContain('重入执行(跳过方案阶段)')
    } finally {
      rmSync(plainDir, { recursive: true, force: true })
    }
  }, 20_000)

  it('prepareRerun 清 phase 后重跑仍是完整两跑(不误判为重入)', async () => {
    process.env.MOCK_MODE = 'success'
    const plainDir = mkdtempSync(join(tmpdir(), 'dispatch-plain-'))
    try {
      const project = createProject({ name: 'plain', path: plainDir })
      const task = createTask(project.id)

      const paused = await runTask(deps, task.id)
      expect(paused.status).toBe('awaiting_confirm')
      // 放弃 → failed,再 prepareRerun 清执行期字段(含 phase/archiveDir)
      tasks.transition(task.id, 'failed', { failReason: 'abandoned' })
      tasks.prepareRerun(task.id)
      const cleared = tasks.get(task.id) as Task
      expect(cleared.phase).toBeNull()
      expect(cleared.archiveDir).toBeNull()
      tasks.transition(task.id, 'scheduled', {})

      // 重跑:phase 已清 → 不走重入,重新方案跑停 awaiting_confirm
      const rerun = await runTask(deps, task.id)
      expect(rerun.status).toBe('awaiting_confirm')
      expect(rerun.phase).toBe('plan')
    } finally {
      rmSync(plainDir, { recursive: true, force: true })
    }
  }, 20_000)
})

describe('confirmPlan(core)确认放行', () => {
  it('守卫先关会话再迁移 scheduled,再入队重入执行 → done', async () => {
    process.env.MOCK_MODE = 'success'
    const project = createProject()
    const task = createTask(project.id)
    const paused = await runTask(deps, task.id)
    expect(paused.status).toBe('awaiting_confirm')

    // closeDiscussion 必须先于状态迁移触发:回调内读到的仍是 awaiting_confirm(证明关会话在迁移前)
    const closeSawStatus: string[] = []
    const scheduled = confirmPlan(deps, task.id, (id) => {
      expect(id).toBe(task.id)
      closeSawStatus.push((tasks.get(task.id) as Task).status)
    })
    expect(closeSawStatus).toEqual(['awaiting_confirm'])
    expect(scheduled.status).toBe('scheduled')
    // 暂停时持久化的 phase/archiveDir 经空 patch 保留,供恢复分支重入
    expect(scheduled.phase).toBe('plan')
    expect(scheduled.archiveDir).toBe(archiveDirOf(project, task))

    // 入队重入:执行跑跳过方案阶段直到合并 done
    const done = await runTask(deps, task.id)
    expect(done.status).toBe('done')
  }, 20_000)

  it('守卫:非 awaiting_confirm / 任务不存在拒绝', async () => {
    const project = createProject()
    const scheduledTask = createTask(project.id) // status scheduled
    expect(() => confirmPlan(deps, scheduledTask.id, () => {})).toThrow(/不可确认/)
    expect(() => confirmPlan(deps, 'no-such-id', () => {})).toThrow(/不存在/)
  })
})

describe('放弃 awaiting_confirm', () => {
  it('awaiting_confirm → failed(abandoned) 且 worktree 与分支清理', async () => {
    process.env.MOCK_MODE = 'success'
    const project = createProject()
    const task = createTask(project.id)
    const paused = await runTask(deps, task.id)
    expect(paused.status).toBe('awaiting_confirm')
    const wt = worktreeDirOf(project, task)
    expect(existsSync(wt)).toBe(true)

    // 复用壳层 task:abandon 的实现路径:abandonTask 置败 → cleanupTaskWorkspace 清理
    const failed = abandonTask(tasks, task.id)
    expect(failed.status).toBe('failed')
    expect(failed.failReason).toBe('abandoned')
    const cleaned = await cleanupTaskWorkspace({ tasks, projects }, task.id)
    expect(cleaned.worktreePath).toBeNull()
    expect(existsSync(wt)).toBe(false)
    expect(branchExists(repo, paused.branch as string)).toBe(false)
  }, 20_000)
})
