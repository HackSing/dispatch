import BetterSqlite3 from 'better-sqlite3'
import type { Database } from 'better-sqlite3'
import { migrate } from './migrations'

export function openDatabase(dbFile: string): Database {
  const db = new BetterSqlite3(dbFile)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

export { SCHEMA_VERSION } from './migrations'
export { TaskStore } from './task-store'
export { ProjectStore, ProjectHasActiveTasksError } from './project-store'
export { DetectionStore } from './detection-store'
