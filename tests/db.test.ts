import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openDatabase, SCHEMA_VERSION, TaskStore, ProjectStore } from '@core/db'
import { IllegalTransitionError } from '@shared/state-machine'
import type { Task } from '@shared/types'

let dir: string
let db: Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dispatch-db-'))
  db = openDatabase(join(dir, 'test.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('migrations', () => {
  it('建库后 user_version = SCHEMA_VERSION', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
  })

  it('重复打开幂等', () => {
    db.close()
    db = openDatabase(join(dir, 'test.db'))
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(db.prepare('SELECT count(*) AS c FROM tasks').get()).toEqual({ c: 0 })
  })
})

describe('TaskStore', () => {
  let projects: ProjectStore
  let projectId: string

  beforeEach(() => {
    projects = new ProjectStore(db)
    projectId = projects.create({ name: 'demo', path: '/tmp/demo' }).id
  })

  it('trigger=none 创建为 todo,无 agent 合法', () => {
    const store = new TaskStore(db)
    const task = store.create({ text: '买猫粮', projectId, triggerType: 'none' })
    expect(task.status).toBe('todo')
    expect(task.agent).toBeNull()
  })

  it('可执行任务缺 agent 拒绝入库', () => {
    const store = new TaskStore(db)
    expect(() => store.create({ text: 'x', projectId, triggerType: 'immediate' })).toThrow(
      /agent/
    )
    expect(() =>
      store.create({ text: 'x', projectId, agent: 'claude-code', triggerType: 'at' })
    ).toThrow(/triggerAt/)
  })

  it('合法迁移更新状态与补丁字段,并触发 onChange', () => {
    const changes: Task[] = []
    const store = new TaskStore(db, (t) => changes.push(t))
    const task = store.create({
      text: '修 bug',
      projectId,
      agent: 'claude-code',
      triggerType: 'immediate'
    })
    expect(task.status).toBe('scheduled')

    const running = store.transition(task.id, 'running', {
      startedAt: '2026-08-22T10:00:00Z',
      baseBranch: 'main',
      branch: `task/${task.id}`
    })
    expect(running.status).toBe('running')
    expect(running.startedAt).toBe('2026-08-22T10:00:00Z')
    expect(running.branch).toBe(`task/${task.id}`)
    expect(changes.map((c) => c.status)).toEqual(['scheduled', 'running'])
  })

  it('非法迁移抛错且不落库', () => {
    const store = new TaskStore(db)
    const task = store.create({ text: 'todo 任务', projectId, triggerType: 'none' })
    expect(() => store.transition(task.id, 'running')).toThrow(IllegalTransitionError)
    expect(store.get(task.id)?.status).toBe('todo')
  })

  it('外键约束:项目不存在时任务拒绝入库', () => {
    const store = new TaskStore(db)
    expect(() =>
      store.create({ text: 'x', projectId: 'nonexistent', triggerType: 'none' })
    ).toThrow(/FOREIGN KEY/)
  })
})
