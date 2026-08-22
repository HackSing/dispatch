/** IPC 通道契约唯一来源:preload 与主进程 handler 均从此派生,禁止手写字符串 channel。 */

import type { TaskStatus } from './state-machine'
import type { AgentDetection, AgentId, Project, Task, TriggerType } from './types'

export interface AppStatus {
  version: string
  dbSchemaVersion: number
  dispatchHome: string
  platform: NodeJS.Platform
}

export interface HotkeyStatus {
  accelerator: string
  registered: boolean
}

export interface CreateTaskPayload {
  text: string
  projectId: string
  agent: AgentId | null
  /** 工作流模式子智能体,可空;非空时 agent 为主智能体 */
  subAgent: AgentId | null
  triggerType: TriggerType
  triggerAt: string | null
}

/** 仅 todo/scheduled 可编辑;trigger 变化引发的 todo↔scheduled 升降级由主进程编排 */
export interface UpdateTaskPayload {
  id: string
  text?: string
  projectId?: string
  agent?: AgentId | null
  subAgent?: AgentId | null
  triggerType?: TriggerType
  triggerAt?: string | null
}

export interface CreateProjectPayload {
  path: string
  /** 缺省取 path 的目录名 */
  name?: string
}

/** 捕获窗记忆项,持久化于 ~/.dispatch/ui-state.json(机器管理,损坏即重建) */
export interface UiState {
  lastAgent: AgentId | null
  lastSubAgent: AgentId | null
  lastProjectId: string | null
}

export interface ArchiveFileInfo {
  name: string
  size: number
}

/** 详情页展示的归档内容,均可能尚未产生(null) */
export interface TaskArchive {
  taskMd: string | null
  planMd: string | null
  resultRaw: string | null
  logTail: string | null
  conflictReport: string | null
  /** 归档目录全部文件(agent 可能产出协议之外的交付物,如生成的文档) */
  files: ArchiveFileInfo[]
}

/** invoke 型通道:渲染层请求 → 主进程响应 */
export interface InvokeMap {
  'app:status': { req: void; res: AppStatus }
  'app:hotkey-status': { req: void; res: HotkeyStatus }
  'task:create': { req: CreateTaskPayload; res: Task }
  'task:list': { req: void; res: Task[] }
  'task:update': { req: UpdateTaskPayload; res: Task }
  'task:toggle-todo': { req: { id: string }; res: Task }
  'task:cancel': { req: { id: string }; res: Task }
  'task:run-now': { req: { id: string }; res: Task }
  'task:archive': { req: { id: string }; res: TaskArchive }
  'task:open-archive': { req: { id: string }; res: void }
  /** failed 任务复制为新任务立即入队(spec 失败重跑);返回新任务 */
  'task:rerun': { req: { id: string }; res: Task }
  /** awaiting_merge/conflict 手动重试合并(spec「已解决,重试合并」) */
  'task:retry-merge': { req: { id: string }; res: Task }
  /** conflict/awaiting_merge 放弃 → failed(fail_reason=abandoned),worktree 保留待清理 */
  'task:abandon': { req: { id: string }; res: Task }
  'project:list': { req: void; res: Project[] }
  'project:create': { req: CreateProjectPayload; res: Project }
  'project:pick-directory': { req: void; res: string | null }
  'agent:detections': { req: void; res: AgentDetection[] }
  'agent:refresh': { req: void; res: AgentDetection[] }
  'ui-state:get': { req: void; res: UiState }
  'ui-state:set': { req: Partial<UiState>; res: UiState }
  'capture:hide': { req: void; res: void }
}

/** 事件型通道:主进程广播 → 渲染层订阅 */
export interface EventMap {
  'task:changed': { taskId: string; status: TaskStatus }
  'agent:detections-changed': { detections: AgentDetection[] }
  /** 系统通知点击等入口要求主窗打开某任务详情 */
  'ui:open-task': { taskId: string }
}

export type InvokeChannel = keyof InvokeMap
export type EventChannel = keyof EventMap

export const INVOKE_CHANNELS: readonly InvokeChannel[] = [
  'app:status',
  'app:hotkey-status',
  'task:create',
  'task:list',
  'task:update',
  'task:toggle-todo',
  'task:cancel',
  'task:run-now',
  'task:archive',
  'task:open-archive',
  'task:rerun',
  'task:retry-merge',
  'task:abandon',
  'project:list',
  'project:create',
  'project:pick-directory',
  'agent:detections',
  'agent:refresh',
  'ui-state:get',
  'ui-state:set',
  'capture:hide'
]
export const EVENT_CHANNELS: readonly EventChannel[] = [
  'task:changed',
  'agent:detections-changed',
  'ui:open-task'
]

/** preload 暴露到 window.dispatchApi 的形状 */
export interface DispatchApi {
  invoke<C extends InvokeChannel>(channel: C, payload: InvokeMap[C]['req']): Promise<InvokeMap[C]['res']>
  on<C extends EventChannel>(channel: C, listener: (payload: EventMap[C]) => void): () => void
}
