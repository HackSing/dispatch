import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openDatabase, ProjectStore, ProjectHasActiveTasksError, TaskStore } from '@core/db'

let dir: string
let db: Database
let projects: ProjectStore
let tasks: TaskStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dispatch-project-'))
  db = openDatabase(join(dir, 'test.db'))
  projects = new ProjectStore(db)
  tasks = new TaskStore(db)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('ProjectStore.update', () => {
  it('部分更新生效,null 可显式清空可空字段', () => {
    const p = projects.create({ name: 'demo', path: '/tmp/demo', prepareCmd: 'npm i' })
    const updated = projects.update(p.id, { name: 'demo2', prepareCmd: null })
    expect(updated).toMatchObject({ name: 'demo2', path: '/tmp/demo', prepareCmd: null })
    expect(projects.get(p.id)).toEqual(updated)
  })

  it('不存在的项目与空名/空路径拒绝', () => {
    expect(() => projects.update('ghost', { name: 'x' })).toThrow(/not found/)
    const p = projects.create({ name: 'demo', path: '/tmp/demo' })
    expect(() => projects.update(p.id, { name: '  ' })).toThrow(/项目名/)
    expect(() => projects.update(p.id, { path: '' })).toThrow(/路径/)
  })
})

describe('ProjectStore.delete', () => {
  it('无任务的项目可删除', () => {
    const p = projects.create({ name: 'demo', path: '/tmp/demo' })
    projects.delete(p.id)
    expect(projects.get(p.id)).toBeNull()
  })

  it('仍有非终态任务(todo/scheduled)拒绝删除', () => {
    const p = projects.create({ name: 'demo', path: '/tmp/demo' })
    tasks.create({ text: '待办', projectId: p.id, triggerType: 'none' })
    expect(() => projects.delete(p.id)).toThrow(ProjectHasActiveTasksError)
    expect(projects.get(p.id)).not.toBeNull()
  })

  it('只剩终态任务时删除成功,任务行随项目清掉', () => {
    const p = projects.create({ name: 'demo', path: '/tmp/demo' })
    const t = tasks.create({ text: '待办', projectId: p.id, triggerType: 'none' })
    tasks.transition(t.id, 'done')
    projects.delete(p.id)
    expect(projects.get(p.id)).toBeNull()
    expect(tasks.get(t.id)).toBeNull()
  })

  it('不存在的项目删除报错', () => {
    expect(() => projects.delete('ghost')).toThrow(/not found/)
  })
})
