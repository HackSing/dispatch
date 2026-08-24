import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { Project } from '@shared/types'
import { SETTLED_STATUSES } from '@shared/state-machine'

/** 已结算态清单见状态机(done 有手动重开边但已结算,不能按「无出边」推导) */
const TERMINAL_STATUSES = SETTLED_STATUSES

interface ProjectRow {
  id: string
  name: string
  path: string
  prepare_cmd: string | null
  base_branch: string | null
  created_at: string
  sort_order: number | null
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    prepareCmd: row.prepare_cmd,
    baseBranch: row.base_branch,
    createdAt: row.created_at
  }
}

export interface CreateProjectInput {
  name: string
  path: string
  prepareCmd?: string | null
  baseBranch?: string | null
  /** default 项目使用固定 id,便于幂等种子 */
  id?: string
}

export class ProjectStore {
  /** onChange 供 shell 层接 IPC 广播(与 TaskStore 同型):捕获窗新建项目须让主窗项目列表同步 */
  constructor(
    private readonly db: Database,
    private readonly onChange?: (projectId: string) => void
  ) {}

  create(input: CreateProjectInput): Project {
    const project: Project = {
      id: input.id ?? randomUUID(),
      name: input.name,
      path: input.path,
      prepareCmd: input.prepareCmd ?? null,
      baseBranch: input.baseBranch ?? null,
      createdAt: new Date().toISOString()
    }
    const { next } = this.db
      .prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM projects')
      .get() as { next: number }
    this.db
      .prepare(
        `INSERT INTO projects (id, name, path, prepare_cmd, base_branch, created_at, sort_order)
         VALUES (@id, @name, @path, @prepareCmd, @baseBranch, @createdAt, @sortOrder)`
      )
      .run({ ...project, sortOrder: next })
    this.onChange?.(project.id)
    return project
  }

  get(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | ProjectRow
      | undefined
    return row ? toProject(row) : null
  }

  list(): Project[] {
    const rows = this.db
      .prepare('SELECT * FROM projects ORDER BY sort_order, created_at')
      .all() as ProjectRow[]
    return rows.map(toProject)
  }

  /** 按给定 id 序列重排看板顺序(全量名单);未知 id 拒绝,空列表为合法 no-op */
  reorder(ids: string[]): void {
    const exists = this.db.prepare('SELECT 1 FROM projects WHERE id = ?')
    const setOrder = this.db.prepare('UPDATE projects SET sort_order = ? WHERE id = ?')
    const run = this.db.transaction(() => {
      ids.forEach((id, index) => {
        if (!exists.get(id)) throw new Error(`project not found: ${id}`)
        setOrder.run(index, id)
      })
    })
    run()
    if (ids.length > 0) this.onChange?.(ids[0])
  }

  update(id: string, patch: UpdateProjectInput): Project {
    const current = this.get(id)
    if (!current) throw new Error(`project not found: ${id}`)
    const next: Project = {
      ...current,
      name: patch.name ?? current.name,
      path: patch.path ?? current.path,
      prepareCmd: patch.prepareCmd !== undefined ? patch.prepareCmd : current.prepareCmd,
      baseBranch: patch.baseBranch !== undefined ? patch.baseBranch : current.baseBranch
    }
    if (!next.name.trim()) throw new Error('项目名不能为空')
    if (!next.path.trim()) throw new Error('项目路径不能为空')
    this.db
      .prepare(
        `UPDATE projects SET name = @name, path = @path,
           prepare_cmd = @prepareCmd, base_branch = @baseBranch WHERE id = @id`
      )
      .run({
        id,
        name: next.name,
        path: next.path,
        prepareCmd: next.prepareCmd,
        baseBranch: next.baseBranch
      })
    this.onChange?.(id)
    return next
  }

  /** 有非终态任务的项目拒绝删除;终态任务随项目一并删行(归档在盘上,库只是索引) */
  delete(id: string): void {
    if (!this.get(id)) throw new Error(`project not found: ${id}`)
    const placeholders = TERMINAL_STATUSES.map(() => '?').join(', ')
    const { c } = this.db
      .prepare(
        `SELECT count(*) AS c FROM tasks WHERE project_id = ? AND status NOT IN (${placeholders})`
      )
      .get(id, ...TERMINAL_STATUSES) as { c: number }
    if (c > 0) throw new ProjectHasActiveTasksError(id, c)
    const run = this.db.transaction(() => {
      this.db.prepare('DELETE FROM tasks WHERE project_id = ?').run(id)
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
    })
    run()
    this.onChange?.(id)
  }
}

export interface UpdateProjectInput {
  name?: string
  path?: string
  prepareCmd?: string | null
  baseBranch?: string | null
}

export class ProjectHasActiveTasksError extends Error {
  constructor(
    public readonly projectId: string,
    public readonly activeCount: number
  ) {
    super(`项目 ${projectId} 仍有 ${activeCount} 个非终态任务,拒绝删除`)
    this.name = 'ProjectHasActiveTasksError'
  }
}
