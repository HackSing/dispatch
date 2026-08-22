import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openDatabase, ProjectStore, TaskStore } from '@core/db'
import { Scheduler } from '@core/scheduler'
import type { Task } from '@shared/types'

const T0 = Date.parse('2026-08-22T10:00:00.000Z')

let home: string
let db: Database
let tasks: TaskStore
let projectId: string
let clock: number
let enqueued: string[]
let retried: string[]

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dispatch-sched-'))
  db = openDatabase(join(home, 'dispatch.db'))
  tasks = new TaskStore(db)
  projectId = new ProjectStore(db).create({ name: 'demo', path: join(home, 'repo') }).id
  clock = T0
  enqueued = []
  retried = []
})

afterEach(() => {
  vi.useRealTimers()
  db.close()
  rmSync(home, { recursive: true, force: true })
})

function makeScheduler(overrides: Partial<ConstructorParameters<typeof Scheduler>[0]> = {}): Scheduler {
  return new Scheduler({
    tasks,
    enqueue: (id) => enqueued.push(id),
    retryMerge: (id) => retried.push(id),
    now: () => new Date(clock),
    ...overrides
  })
}

function atTask(offsetMs: number): Task {
  return tasks.create({
    text: 'scheduled task',
    projectId,
    agent: 'claude-code',
    triggerType: 'at',
    triggerAt: new Date(T0 + offsetMs).toISOString()
  })
}

function awaitingMergeTask(): Task {
  const t = tasks.create({
    text: 'merge me',
    projectId,
    agent: 'claude-code',
    triggerType: 'immediate'
  })
  tasks.transition(t.id, 'running')
  tasks.transition(t.id, 'merging')
  return tasks.transition(t.id, 'awaiting_merge', { failReason: 'base_dirty' })
}

describe('Scheduler tick — scheduled 扫描', () => {
  it('到点触发,未到点不触发', () => {
    const due = atTask(-1000)
    atTask(60_000)
    makeScheduler().tick()
    expect(enqueued).toEqual([due.id])
  })

  it('触发时刻等于当前时刻也算到点', () => {
    const task = atTask(0)
    makeScheduler().tick()
    expect(enqueued).toEqual([task.id])
  })

  it('immediate 残留任务捡漏入队', () => {
    const task = tasks.create({
      text: 'leftover immediate',
      projectId,
      agent: 'claude-code',
      triggerType: 'immediate'
    })
    makeScheduler().tick()
    expect(enqueued).toEqual([task.id])
  })

  it('in-flight 去重:入队后仍是 scheduled 的任务不重复入队', () => {
    const task = atTask(-1000)
    const scheduler = makeScheduler()
    scheduler.tick()
    scheduler.tick()
    clock += 30_000
    scheduler.tick()
    expect(enqueued).toEqual([task.id])
  })

  it('任务落定后 in-flight 回收;scheduled→todo→scheduled 循环可重新入队', () => {
    const task = atTask(-1000)
    const scheduler = makeScheduler()
    scheduler.tick()
    expect(enqueued).toEqual([task.id])
    tasks.transition(task.id, 'todo')
    scheduler.tick()
    expect(enqueued).toEqual([task.id])
    tasks.transition(task.id, 'scheduled')
    scheduler.tick()
    expect(enqueued).toEqual([task.id, task.id])
  })

  it('enqueueNow 与 tick 共享去重(恢复链路入口)', () => {
    const task = atTask(-1000)
    const scheduler = makeScheduler()
    scheduler.enqueueNow(task.id)
    scheduler.tick()
    expect(enqueued).toEqual([task.id])
  })

  it('已入队转 running 的任务不再触发', () => {
    const task = atTask(-1000)
    const scheduler = makeScheduler()
    scheduler.tick()
    tasks.transition(task.id, 'running')
    scheduler.tick()
    expect(enqueued).toEqual([task.id])
  })
})

describe('Scheduler tick — awaiting_merge 周期重试', () => {
  it('首见即重试,60s 内节流,超过后再次重试', () => {
    const task = awaitingMergeTask()
    const scheduler = makeScheduler()
    scheduler.tick()
    expect(retried).toEqual([task.id])
    clock += 30_000
    scheduler.tick()
    expect(retried).toEqual([task.id])
    clock += 30_000
    scheduler.tick()
    expect(retried).toEqual([task.id, task.id])
  })

  it('重试节流跨 merging 窗口保持:tick 恰逢 merging 不重置计时', () => {
    const task = awaitingMergeTask()
    const scheduler = makeScheduler()
    scheduler.tick()
    tasks.transition(task.id, 'merging')
    clock += 30_000
    scheduler.tick()
    tasks.transition(task.id, 'awaiting_merge', { failReason: 'base_dirty' })
    clock += 10_000
    scheduler.tick()
    expect(retried).toEqual([task.id])
    clock += 20_000
    scheduler.tick()
    expect(retried).toEqual([task.id, task.id])
  })

  it('conflict 任务不进自动重试(仅手动)', () => {
    const task = awaitingMergeTask()
    tasks.transition(task.id, 'merging')
    tasks.transition(task.id, 'conflict')
    makeScheduler().tick()
    expect(retried).toEqual([])
  })
})

describe('Scheduler start/stop', () => {
  it('start 立即 tick 一次,随后按 intervalMs 周期扫描,stop 后停止', () => {
    vi.useFakeTimers()
    const first = atTask(-1000)
    const scheduler = makeScheduler()
    scheduler.start()
    expect(enqueued).toEqual([first.id])
    const second = atTask(-500)
    vi.advanceTimersByTime(30_000)
    expect(enqueued).toEqual([first.id, second.id])
    scheduler.stop()
    atTask(-200)
    vi.advanceTimersByTime(120_000)
    expect(enqueued).toEqual([first.id, second.id])
  })

  it('重复 start 幂等,不叠加定时器', () => {
    vi.useFakeTimers()
    const scheduler = makeScheduler()
    scheduler.start()
    scheduler.start()
    const task = atTask(-1000)
    vi.advanceTimersByTime(30_000)
    expect(enqueued).toEqual([task.id])
    scheduler.stop()
  })
})
