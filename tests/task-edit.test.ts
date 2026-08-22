import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openDatabase, ProjectStore, TaskStore } from '@core/db'
import { cancelScheduled, completeTodo, editTask } from '@core/task-edit'
import type { Task } from '@shared/types'

let dir: string
let db: Database
let store: TaskStore
let projectId: string
let changes: Task[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dispatch-task-edit-'))
  db = openDatabase(join(dir, 'test.db'))
  changes = []
  store = new TaskStore(db, (t) => changes.push(t))
  projectId = new ProjectStore(db).create({ name: 'demo', path: '/tmp/demo' }).id
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

describe('completeTodo / cancelScheduled', () => {
  it('todo 勾选完成 → done + finishedAt', () => {
    const t = store.create({ text: 'x', projectId, triggerType: 'none' })
    const done = completeTodo(store, t.id)
    expect(done.status).toBe('done')
    expect(done.finishedAt).not.toBeNull()
    expect(() => completeTodo(store, t.id)).toThrow(/todo/)
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
