import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { Project } from '@shared/types'

interface ProjectRow {
  id: string
  name: string
  path: string
  prepare_cmd: string | null
  base_branch: string | null
  created_at: string
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
  constructor(private readonly db: Database) {}

  create(input: CreateProjectInput): Project {
    const project: Project = {
      id: input.id ?? randomUUID(),
      name: input.name,
      path: input.path,
      prepareCmd: input.prepareCmd ?? null,
      baseBranch: input.baseBranch ?? null,
      createdAt: new Date().toISOString()
    }
    this.db
      .prepare(
        `INSERT INTO projects (id, name, path, prepare_cmd, base_branch, created_at)
         VALUES (@id, @name, @path, @prepareCmd, @baseBranch, @createdAt)`
      )
      .run({ ...project })
    return project
  }

  get(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | ProjectRow
      | undefined
    return row ? toProject(row) : null
  }

  list(): Project[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY created_at').all() as ProjectRow[]
    return rows.map(toProject)
  }
}
