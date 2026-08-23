import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openDatabase, ProjectStore } from '@core/db'
import { createProject } from '@core/project-ops'

let dir: string
let db: Database
let projects: ProjectStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dispatch-project-ops-'))
  db = openDatabase(join(dir, 'test.db'))
  projects = new ProjectStore(db)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('createProject(两壳共用唯一入口)', () => {
  it('路径不存在:拒绝入库并给中文错误(幽灵项目缺陷回归)', () => {
    expect(() => createProject(projects, { path: join(dir, 'not-there') })).toThrow(
      /路径不存在或不是文件夹/
    )
    expect(projects.list()).toHaveLength(0)
  })

  it('路径是文件而非目录:同样拒绝', () => {
    const file = join(dir, 'a-file.txt')
    writeFileSync(file, 'x', 'utf-8')
    expect(() => createProject(projects, { path: file })).toThrow(/路径不存在或不是文件夹/)
  })

  it('空白路径:拒绝', () => {
    expect(() => createProject(projects, { path: '   ' })).toThrow(/项目路径不能为空/)
  })

  it('合法目录:创建成功,默认名取 basename,路径经 trim', () => {
    const p = createProject(projects, { path: `  ${dir}  ` })
    expect(p.path).toBe(dir)
    expect(p.name).toBe(basename(dir))
  })

  it('同路径重复创建:幂等返回已有项目', () => {
    const first = createProject(projects, { path: dir })
    const again = createProject(projects, { path: dir, name: '换个名字也不生效' })
    expect(again.id).toBe(first.id)
    expect(projects.list()).toHaveLength(1)
  })
})
