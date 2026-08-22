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
  triggerType: TriggerType
  triggerAt: string | null
}

/** 仅 todo/scheduled 可编辑;trigger 变化引发的 todo↔scheduled 升降级由主进程编排 */
export interface UpdateTaskPayload {
  id: string
  text?: string
  projectId?: string
  agent?: AgentId | null
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
  lastProjectId: string | null
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
  'project:list',
  'project:create',
  'project:pick-directory',
  'agent:detections',
  'agent:refresh',
  'ui-state:get',
  'ui-state:set',
  'capture:hide'
]
export const EVENT_CHANNELS: readonly EventChannel[] = ['task:changed', 'agent:detections-changed']

/** preload 暴露到 window.dispatchApi 的形状 */
export interface DispatchApi {
  invoke<C extends InvokeChannel>(channel: C, payload: InvokeMap[C]['req']): Promise<InvokeMap[C]['res']>
  on<C extends EventChannel>(channel: C, listener: (payload: EventMap[C]) => void): () => void
}
