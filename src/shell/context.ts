import type { Database } from 'better-sqlite3'
import type { DispatchPaths } from '@core/paths'
import type { DispatchConfig } from '@core/config'
import type { TaskStore, ProjectStore, DetectionStore } from '@core/db'
import type { HotkeyStatus } from '@shared/ipc'

/** 主进程装配好的运行时依赖,IPC handler 与调度器从这里取,不各自重建 */
export interface AppContext {
  paths: DispatchPaths
  config: DispatchConfig
  db: Database
  tasks: TaskStore
  projects: ProjectStore
  detections: DetectionStore
  hotkey: HotkeyStatus
}
