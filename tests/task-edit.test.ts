import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openDatabase, ProjectStore, TaskStore } from '@core/db'
import { abandonTask, cancelScheduled, editTask, rerunFailedTask, toggleTodo } from '@core/task-edit'
import type { Task } from '@shared/types'

let dir: string
let db: Database
let store: TaskStore
let projectId: string
let changes: Task[]
let projects: ProjectStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dispatch-task-edit-'))
  db = openDatabase(join(dir, 'test.db'))
  changes = []
  store = new TaskStore(db, (t) => changes.push(t))
  projects = new ProjectStore(db)
  projectId = projects.create({ name: 'demo', path: '/tmp/demo' }).id
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('TaskStore.updateEditable', () => {
  it('todo 可改文本/项目/agent,校验规则与 create 一致', () => {
    const t = store.create({ text: '旧', projectId, triggerType: 'none' })
    const updated = store.updateEditable(t.id, { text: '新', agent: 'claude-code' })
    expect(updated).toMatchObject({ text: '新', agent: 'claude-code', status: 'todo' })

    expect(() => store.updateEditable(t.id, { text: ' ' })).toThrow(/文本/)
    expect(() => store.updateEditable(t.id, { triggerType: 'at', agent: null })).toThrow(/agent/)
    expect(() =>
      store.updateEditable(t.id, { triggerType: 'at', triggerAt: null })
    ).toThrow(/triggerAt/)
  })

  it('trigger 改为非 at 时清空 triggerAt', () => {
    const t = store.create({
      text: 'x',
      projectId,
      agent: 'claude-code',
      triggerType: 'at',
      triggerAt: '2026-09-01T10:00:00.000Z'
    })
    const updated = store.updateEditable(t.id, { triggerType: 'immediate' })
    expect(updated.triggerAt).toBeNull()
  })

  it('非 todo/scheduled 状态拒绝编辑', () => {
    const t = store.create({ text: 'x', projectId, triggerType: 'none' })
    store.transition(t.id, 'done')
    expect(() => store.updateEditable(t.id, { text: 'y' })).toThrow(/不可编辑/)
  })
})

describe('editTask 升降级编排', () => {
  it('todo 补时间+agent → 升级为 scheduled(经 transition)', () => {
    const t = store.create({ text: '待办', projectId, triggerType: 'none' })
    const upgraded = editTask(store, t.id, {
      agent: 'claude-code',
      triggerType: 'at',
      triggerAt: '2026-09-01T10:00:00.000Z'
    })
    expect(upgraded.status).toBe('scheduled')
    expect(upgraded.scheduledAt).not.toBeNull()
    expect(changes.map((c) => c.status)).toEqual(['todo', 'todo', 'scheduled'])
  })

  it('scheduled 改 trigger 为空 → 降级回 todo', () => {
    const t = store.create({ text: 'x', projectId, agent: 'claude-code', triggerType: 'immediate' })
    const downgraded = editTask(store, t.id, { triggerType: 'none' })
    expect(downgraded.status).toBe('todo')
    expect(downgraded.triggerType).toBe('none')
    expect(downgraded.scheduledAt).toBeNull()
  })

  it('不动 trigger 的编辑保持状态不变', () => {
    const t = store.create({ text: 'x', projectId, agent: 'claude-code', triggerType: 'immediate' })
    const updated = editTask(store, t.id, { text: 'y' })
    expect(updated).toMatchObject({ text: 'y', status: 'scheduled' })
  })

  it('终态任务拒绝编辑', () => {
    const t = store.create({ text: 'x', projectId, triggerType: 'none' })
    store.transition(t.id, 'done')
    expect(() => editTask(store, t.id, { text: 'y' })).toThrow(/不可编辑/)
  })
})

describe('toggleTodo / cancelScheduled', () => {
  it('todo 勾选完成 → done + finishedAt;再切换重开回 todo', () => {
    const t = store.create({ text: 'x', projectId, triggerType: 'none' })
    const done = toggleTodo(store, t.id)
    expect(done.status).toBe('done')
    expect(done.finishedAt).not.toBeNull()
    const reopened = toggleTodo(store, t.id)
    expect(reopened.status).toBe('todo')
  })

  it('todo/done 之外的状态不可勾选切换', () => {
    const t = store.create({ text: 'x', projectId, agent: 'claude-code', triggerType: 'immediate' })
    expect(() => toggleTodo(store, t.id)).toThrow(/scheduled/)
  })

  it('scheduled 取消 → todo,trigger 清空、agent 保留', () => {
    const t = store.create({ text: 'x', projectId, agent: 'claude-code', triggerType: 'immediate' })
    const cancelled = cancelScheduled(store, t.id)
    expect(cancelled).toMatchObject({
      status: 'todo',
      triggerType: 'none',
      triggerAt: null,
      scheduledAt: null,
      agent: 'claude-code'
    })
    expect(() => cancelScheduled(store, t.id)).toThrow(/scheduled/)
  })
})

function makeFailed(): Task {
  const t = store.create({
    text: '原任务首行\n第二行细节',
    projectId,
    agent: 'claude-code',
    triggerType: 'at',
    triggerAt: '2026-09-01T10:00:00.000Z'
  })
  store.transition(t.id, 'running', { startedAt: new Date().toISOString() })
  return store.transition(t.id, 'failed', {
    failReason: 'timeout',
    finishedAt: new Date().toISOString()
  })
}

function makeMerging(): Task {
  const t = store.create({ text: 'x', projectId, agent: 'claude-code', triggerType: 'immediate' })
  store.transition(t.id, 'running')
  return store.transition(t.id, 'merging')
}

describe('rerunFailedTask 原地重跑', () => {
  it('failed → 清执行期字段(含 phase/reviewRound/sessionId)后同任务重新入队,不复制新行', async () => {
    const failed = makeFailed()
    const rerun = await rerunFailedTask({ tasks: store, projects }, failed.id)
    expect(rerun.id).toBe(failed.id)
    expect(rerun).toMatchObject({
      text: failed.text,
      triggerType: 'immediate',
      triggerAt: null,
      status: 'scheduled',
      failReason: null,
      startedAt: null,
      finishedAt: null,
      mergedAt: null,
      phase: null,
      reviewRound: 0,
      sessionId: null,
      worktreePath: null,
      branch: null,
      archiveDir: null
    })
    // 唯一任务行:列表不堆积失败副本
    expect(store.list()).toHaveLength(1)
  })

  it('非 failed 拒绝重跑', async () => {
    const scheduled = store.create({
      text: 'x',
      projectId,
      agent: 'claude-code',
      triggerType: 'immediate'
    })
    await expect(rerunFailedTask({ tasks: store, projects }, scheduled.id)).rejects.toThrow(
      /failed/
    )
    const todo = store.create({ text: 'y', projectId, triggerType: 'none' })
    store.transition(todo.id, 'done')
    await expect(rerunFailedTask({ tasks: store, projects }, todo.id)).rejects.toThrow(/failed/)
  })

  it('任务不存在报错', async () => {
    await expect(rerunFailedTask({ tasks: store, projects }, 'nope')).rejects.toThrow(/not found/)
  })
})

describe('abandonTask 放弃', () => {
  it('conflict → failed(fail_reason=abandoned)', () => {
    const t = makeMerging()
    store.transition(t.id, 'conflict', { finishedAt: '2026-08-22T01:00:00.000Z' })
    const abandoned = abandonTask(store, t.id)
    expect(abandoned).toMatchObject({
      status: 'failed',
      failReason: 'abandoned',
      finishedAt: '2026-08-22T01:00:00.000Z'
    })
  })

  it('awaiting_merge → failed(fail_reason=abandoned)', () => {
    const t = makeMerging()
    store.transition(t.id, 'awaiting_merge', { failReason: 'base_dirty' })
    const abandoned = abandonTask(store, t.id)
    expect(abandoned.status).toBe('failed')
    expect(abandoned.failReason).toBe('abandoned')
    expect(abandoned.finishedAt).not.toBeNull()
  })

  it('其余状态拒绝放弃', () => {
    const failed = makeFailed()
    expect(() => abandonTask(store, failed.id)).toThrow(/可放弃/)
    const merging = makeMerging()
    expect(() => abandonTask(store, merging.id)).toThrow(/可放弃/)
    expect(() => abandonTask(store, 'nope')).toThrow(/not found/)
  })
})
