import type { Database } from 'better-sqlite3'

interface Migration {
  version: number
  name: string
  sql: string
}

/** 只增不改:已发布的迁移禁止修改,schema 变更追加新条目 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `
      CREATE TABLE projects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        path        TEXT NOT NULL,
        prepare_cmd TEXT,
        base_branch TEXT,
        created_at  TEXT NOT NULL
      );

      CREATE TABLE tasks (
        id            TEXT PRIMARY KEY,
        created_at    TEXT NOT NULL,
        text          TEXT NOT NULL,
        project_id    TEXT NOT NULL REFERENCES projects(id),
        agent         TEXT,
        trigger_type  TEXT NOT NULL,
        trigger_at    TEXT,
        status        TEXT NOT NULL,
        base_branch   TEXT,
        branch        TEXT,
        worktree_path TEXT,
        archive_dir   TEXT,
        fail_reason   TEXT,
        scheduled_at  TEXT,
        started_at    TEXT,
        finished_at   TEXT,
        merged_at     TEXT
      );
      CREATE INDEX idx_tasks_status_trigger ON tasks(status, trigger_at);
      CREATE INDEX idx_tasks_project ON tasks(project_id);

      CREATE TABLE agent_detections (
        agent_id    TEXT PRIMARY KEY,
        ok          INTEGER NOT NULL,
        version     TEXT,
        fail_reason TEXT,
        checked_at  TEXT NOT NULL
      );
    `
  },
  {
    version: 2,
    name: 'workflow-stage1',
    sql: `
      ALTER TABLE tasks ADD COLUMN sub_agent TEXT;
      ALTER TABLE tasks ADD COLUMN phase TEXT;
      ALTER TABLE tasks ADD COLUMN review_round INTEGER NOT NULL DEFAULT 0;
    `
  },
  {
    version: 3,
    name: 'session-follow-up',
    sql: `
      ALTER TABLE tasks ADD COLUMN session_id TEXT;
      ALTER TABLE tasks ADD COLUMN parent_task_id TEXT REFERENCES tasks(id);
    `
  }
]

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version

export function migrate(db: Database): void {
  const current = db.pragma('user_version', { simple: true }) as number
  if (current > SCHEMA_VERSION) {
    throw new Error(`数据库 schema v${current} 高于应用支持的 v${SCHEMA_VERSION},请升级应用`)
  }
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue
    const apply = db.transaction(() => {
      db.exec(m.sql)
      db.pragma(`user_version = ${m.version}`)
    })
    apply()
  }
}
