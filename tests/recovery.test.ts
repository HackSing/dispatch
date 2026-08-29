import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openDatabase, ProjectStore, TaskStore } from '@core/db'
import { ConfigSchema, type DispatchConfig } from '@core/config'
import { ensureDispatchDirs, resolvePaths, type DispatchPaths } from '@core/paths'
import { createArchive } from '@core/archive'
import { createTaskWorktree } from '@core/gitops'
import { recoverOnStartup } from '@core/scheduler'
import { sanitizeName } from '@core/naming'
import type { Project, Task } from '@shared/types'
import { makeGitRepo } from './fixtures/git-repo'

const NOW = new Date('2026-08-22T10:00:00.000Z')

let home: string
let repo: string
let paths: DispatchPaths
let db: Database
let tasks: TaskStore
let projects: ProjectStore
let project: Project
let enqueued: string[]

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dispatch-recover-'))
  repo = makeGitRepo()
  paths = resolvePaths(home)
  ensureDispatchDirs(paths)
  db = openDatabase(paths.dbFile)
  tasks = new TaskStore(db)
  projects = new ProjectStore(db)
  project = projects.create({ name: 'demo', path: repo })
  enqueued = []
})

afterEach(() => {
  db.close()
  rmSync(home, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

function config(policy: DispatchConfig['missed_task_policy'] = 'run'): DispatchConfig {
  return ConfigSchema.parse({ missed_task_policy: policy })
}

function recover(cfg: DispatchConfig = config()): ReturnType<typeof recoverOnStartup> {
  return recoverOnStartup({
    tasks,
    projects,
    config: cfg,
    paths,
    enqueue: (id) => enqueued.push(id),
    now: () => NOW
  })
}

function createImmediate(text = 'crashed task'): Task {
  return tasks.create({ text, projectId: project.id, agent: 'claude-code', triggerType: 'immediate' })
}

function createAt(triggerAt: string): Task {
  return tasks.create({
    text: 'timed task',
    projectId: project.id,
    agent: 'claude-code',
    triggerType: 'at',
    triggerAt
  })
}

describe('recoverOnStartup — 中断残留', () => {
  it('running 残留 → failed(interrupted)', async () => {
    const task = createImmediate()
    tasks.transition(task.id, 'running', { startedAt: NOW.toISOString(), baseBranch: 'main' })

    const report = await recover()
    const after = tasks.get(task.id) as Task
    expect(after.status).toBe('failed')
    expect(after.failReason).toBe('interrupted')
    expect(after.finishedAt).toBe(NOW.toISOString())
    expect(report.interrupted).toEqual([task.id])
    expect(report.errors).toEqual([])
  })

  it('merging 残留 → failed(interrupted),已入库的 worktree 路径保留', async () => {
    const task = createImmediate()
    tasks.transition(task.id, 'running')
    tasks.transition(task.id, 'merging', {
      worktreePath: '/tmp/some-worktree',
      branch: 'task/abc',
      archiveDir: '/tmp/some-archive'
    })

    const report = await recover()
    const after = tasks.get(task.id) as Task
    expect(after.status).toBe('failed')
    expect(after.failReason).toBe('interrupted')
    expect(after.worktreePath).toBe('/tmp/some-worktree')
    expect(report.interrupted).toEqual([task.id])
  })
})

describe('recoverOnStartup — 过期 scheduled', () => {
  it('missed_task_policy=run → 原任务入队,状态仍为 scheduled', async () => {
    const missed = createAt('2026-08-22T09:00:00.000Z')
    const future = createAt('2026-08-22T11:00:00.000Z')

    const report = await recover(config('run'))
    expect(enqueued).toEqual([missed.id])
    expect(report.missedRun).toEqual([missed.id])
    expect((tasks.get(missed.id) as Task).status).toBe('scheduled')
    expect((tasks.get(future.id) as Task).status).toBe('scheduled')
  })

  it('missed_task_policy=skip → failed(missed_skipped),未过期不动', async () => {
    const missed = createAt('2026-08-22T09:59:59.000Z')
    const future = createAt('2026-08-22T10:00:01.000Z')

    const report = await recover(config('skip'))
    expect(enqueued).toEqual([])
    expect(report.missedSkipped).toEqual([missed.id])
    const after = tasks.get(missed.id) as Task
    expect(after.status).toBe('failed')
    expect(after.failReason).toBe('missed_skipped')
    expect((tasks.get(future.id) as Task).status).toBe('scheduled')
  })

  it('immediate 残留不按 missed 处理,留给调度器首个 tick', async () => {
    const task = createImmediate()
    const report = await recover(config('skip'))
    expect(report.missedSkipped).toEqual([])
    expect((tasks.get(task.id) as Task).status).toBe('scheduled')
  })
})

describe('recoverOnStartup — 孤儿 worktree 回填', () => {
  it('running 中断且路径未入库 → 置 failed 后按目录扫描回填三字段', async () => {
    const task = createImmediate('fix orphan worktree')
    tasks.transition(task.id, 'running', { startedAt: NOW.toISOString(), baseBranch: 'main' })
    const running = tasks.get(task.id) as Task
    // 模拟崩溃现场:worktree 与归档目录已在盘上,db 里三字段仍为 null
    const wt = await createTaskWorktree({
      projectPath: repo,
      worktreesDir: paths.worktreesDir,
      projectName: project.name,
      taskId: task.id,
      taskText: task.text,
      baseBranch: 'main'
    })
    const { archiveDir } = createArchive(paths, project, running, { vcs: 'git', now: NOW })
    expect(running.worktreePath).toBeNull()

    const report = await recover()
    const after = tasks.get(task.id) as Task
    expect(after.status).toBe('failed')
    expect(after.failReason).toBe('interrupted')
    expect(after.worktreePath).toBe(wt.worktreePath)
    expect(after.branch).toBe(wt.branch)
    expect(after.archiveDir).toBe(archiveDir)
    expect(report.reattached).toEqual([task.id])
    expect(report.errors).toEqual([])
    expect(existsSync(wt.worktreePath)).toBe(true)
  })

  it('对不上任务 id 的孤儿目录跳过,不报错', async () => {
    const stray = join(paths.worktreesDir, sanitizeName(project.name), 'not-a-task-id')
    await createTaskWorktree({
      projectPath: repo,
      worktreesDir: paths.worktreesDir,
      projectName: project.name,
      taskId: 'not-a-task-id',
      taskText: 'stray',
      baseBranch: 'main'
    })

    const report = await recover()
    expect(report.reattached).toEqual([])
    expect(report.errors).toEqual([])
    expect(existsSync(stray)).toBe(true)
  })

  it('db 已有路径的任务不重复回填', async () => {
    const task = createImmediate()
    tasks.transition(task.id, 'running')
    const wt = await createTaskWorktree({
      projectPath: repo,
      worktreesDir: paths.worktreesDir,
      projectName: project.name,
      taskId: task.id,
      taskText: task.text,
      baseBranch: 'main'
    })
    tasks.transition(task.id, 'failed', {
      failReason: 'timeout',
      worktreePath: wt.worktreePath,
      branch: wt.branch
    })

    const report = await recover()
    expect(report.reattached).toEqual([])
    expect((tasks.get(task.id) as Task).failReason).toBe('timeout')
  })

  it('awaiting_merge 残留仅登记,交调度器周期重试', async () => {
    const task = createImmediate()
    tasks.transition(task.id, 'running')
    tasks.transition(task.id, 'merging')
    tasks.transition(task.id, 'awaiting_merge', { failReason: 'base_dirty' })

    const report = await recover()
    expect(report.awaitingMerge).toEqual([task.id])
    expect((tasks.get(task.id) as Task).status).toBe('awaiting_merge')
  })

  it('awaiting_confirm 无在跑进程、产物已落盘,重启后原样保留且不进任何恢复桶', async () => {
    const task = createImmediate()
    tasks.transition(task.id, 'running', { startedAt: NOW.toISOString(), baseBranch: 'main' })
    // 方案判过暂停:archiveDir/worktreePath/branch 随迁移落库,phase 冻结为 plan
    tasks.transition(task.id, 'awaiting_confirm', {
      worktreePath: '/tmp/some-worktree',
      branch: 'task/abc',
      archiveDir: '/tmp/some-archive'
    })

    const report = await recover()
    const after = tasks.get(task.id) as Task
    expect(after.status).toBe('awaiting_confirm')
    expect(after.worktreePath).toBe('/tmp/some-worktree')
    expect(after.branch).toBe('task/abc')
    expect(after.archiveDir).toBe('/tmp/some-archive')
    // 不被中断、不回填、不登记 awaiting_merge、不入队
    expect(report.interrupted).toEqual([])
    expect(report.reattached).toEqual([])
    expect(report.awaitingMerge).toEqual([])
    expect(enqueued).toEqual([])
    expect(report.errors).toEqual([])
  })
})

describe('TaskStore.attachRuntimePaths 约束', () => {
  it('仅 failed/conflict/awaiting_merge 可回填,其余状态抛错', () => {
    const task = createImmediate()
    expect(() => tasks.attachRuntimePaths(task.id, { worktreePath: '/tmp/x' })).toThrow(
      /不允许回填/
    )
    tasks.transition(task.id, 'running')
    expect(() => tasks.attachRuntimePaths(task.id, { worktreePath: '/tmp/x' })).toThrow(
      /不允许回填/
    )
  })

  it('已有值的字段禁止覆盖', () => {
    const task = createImmediate()
    tasks.transition(task.id, 'running')
    tasks.transition(task.id, 'failed', { failReason: 'timeout', worktreePath: '/tmp/keep' })
    expect(() => tasks.attachRuntimePaths(task.id, { worktreePath: '/tmp/other' })).toThrow(
      /禁止覆盖/
    )
    expect((tasks.get(task.id) as Task).worktreePath).toBe('/tmp/keep')
  })

  it('空字段可补写,状态与其余字段不动', () => {
    const task = createImmediate()
    tasks.transition(task.id, 'running')
    tasks.transition(task.id, 'failed', { failReason: 'interrupted' })
    const after = tasks.attachRuntimePaths(task.id, {
      worktreePath: '/tmp/wt',
      branch: 'task/abcd1234',
      archiveDir: '/tmp/archive'
    })
    expect(after.status).toBe('failed')
    expect(after.failReason).toBe('interrupted')
    expect(after.worktreePath).toBe('/tmp/wt')
    expect(after.branch).toBe('task/abcd1234')
    expect(after.archiveDir).toBe('/tmp/archive')
  })
})
