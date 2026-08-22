import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openDatabase, ProjectStore } from '@core/db'
import { DEFAULT_PROJECT_ID, seedDefaultProject } from '@core/bootstrap'

let dir: string
let projectDir: string
let db: Database
let projects: ProjectStore

function commitCount(cwd: string): number {
  return Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd }).toString().trim())
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dispatch-bootstrap-'))
  projectDir = join(dir, 'Dispatch', 'default')
  db = openDatabase(join(dir, 'test.db'))
  projects = new ProjectStore(db)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('seedDefaultProject', () => {
  it('首启:建目录、git init、空首次提交、项目行落库', async () => {
    const result = await seedDefaultProject(projects, projectDir)
    expect(result.created).toBe(true)
    expect(existsSync(join(projectDir, '.git'))).toBe(true)
    expect(commitCount(projectDir)).toBe(1)

    const row = projects.get(DEFAULT_PROJECT_ID)
    expect(row).toMatchObject({ id: DEFAULT_PROJECT_ID, name: 'default', path: projectDir })
  })

  it('幂等:项目行已存在则整体跳过,不追加提交', async () => {
    await seedDefaultProject(projects, projectDir)
    const again = await seedDefaultProject(projects, projectDir)
    expect(again.created).toBe(false)
    expect(projects.list()).toHaveLength(1)
    expect(commitCount(projectDir)).toBe(1)
  })

  it('目录已是带提交的 git 仓库:不重复 init,只补项目行', async () => {
    execFileSync('git', ['init', projectDir])
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'x'],
      { cwd: projectDir }
    )
    const result = await seedDefaultProject(projects, projectDir)
    expect(result.created).toBe(true)
    expect(commitCount(projectDir)).toBe(1)
  })

  it('目录存在但 git init 后无提交:补空首次提交', async () => {
    execFileSync('git', ['init', projectDir])
    await seedDefaultProject(projects, projectDir)
    expect(commitCount(projectDir)).toBe(1)
  })
})
