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

/** 界面记忆项(捕获窗默认值 + 主窗折叠态),持久化于 ~/.dispatch/ui-state.json(机器管理,损坏即重建) */
export interface UiState {
  lastAgent: AgentId | null
  lastSubAgent: AgentId | null
  lastProjectId: string | null
  /** 主窗清单页折叠起来的项目分组 */
  collapsedProjectIds: string[]
}

export interface ArchiveFileInfo {
  name: string
  size: number
}

/** 会话能力(主进程由 config 算出,渲染层不触配置):followUp=可开面板,terminal=可开终端 */
export interface AgentSessionCapability {
  followUp: boolean
  terminal: boolean
}

export interface SessionRoundResult {
  durationMs: number
  costUsd: number | null
  isError: boolean
}

/** 面板会话事件流:round-start → chunk* → round-result,会话终结时 closed */
export interface SessionEventPayload {
  taskId: string
  kind: 'round-start' | 'chunk' | 'round-result' | 'closed'
  round?: number
  /** kind=chunk:过滤后的人读文本增量 */
  text?: string
  /** kind=round-result */
  result?: SessionRoundResult
  /** kind=closed */
  reason?: 'finished' | 'abandoned' | 'failed'
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
  /** conflict/awaiting_merge 放弃 → failed(abandoned),并同步清理 worktree 与任务分支 */
  'task:abandon': { req: { id: string }; res: Task }
  /** failed 任务手动清理遗留 worktree 与分支(归档保留);无 worktree 时为 no-op */
  'task:cleanup-worktree': { req: { id: string }; res: Task }
  /** 运行中任务用户中断 → failed(user_interrupted),worktree 保留可重跑/追问 */
  'task:interrupt': { req: { id: string }; res: void }
  /** 删除任务及其接力链(执行中拒绝);清理遗留 worktree/分支,磁盘归档保留,不可恢复 */
  'task:delete': { req: { id: string }; res: void }
  /** done/failed 任务开面板会话:创建接力任务并就绪 worktree/传输,返回接力任务 */
  'task:follow-up-start': { req: { parentId: string }; res: Task }
  /** 契约:同步校验后立即返回,轮次进展经 task:session-event 广播 */
  'task:follow-up-send': { req: { id: string; text: string }; res: void }
  /** 完成会话并合并;契约:立即返回当前任务,合并进展经 task:changed 广播 */
  'task:follow-up-finish': { req: { id: string }; res: Task }
  /** 放弃会话 → failed(session_abandoned) 并清理 worktree;同 finish 为异步契约 */
  'task:follow-up-abandon': { req: { id: string }; res: Task }
  /** 终端逃生舱:对有 sessionId 的任务拉起交互式 resume 终端 */
  'task:open-session-terminal': { req: { id: string }; res: void }
  'agent:capabilities': { req: void; res: Record<AgentId, AgentSessionCapability> }
  'project:list': { req: void; res: Project[] }
  'project:create': { req: CreateProjectPayload; res: Project }
  /** 移除项目登记:有非终态任务时拒绝;磁盘目录与归档不动 */
  'project:remove': { req: { id: string }; res: void }
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
  'task:session-event': SessionEventPayload
  /** 项目增改删(常来自捕获窗),各窗口项目列表随之刷新 */
  'project:changed': { projectId: string }
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
  'task:cleanup-worktree',
  'task:interrupt',
  'task:delete',
  'task:follow-up-start',
  'task:follow-up-send',
  'task:follow-up-finish',
  'task:follow-up-abandon',
  'task:open-session-terminal',
  'agent:capabilities',
  'project:list',
  'project:create',
  'project:remove',
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
  'ui:open-task',
  'task:session-event',
  'project:changed'
]

/** preload 暴露到 window.dispatchApi 的形状 */
export interface DispatchApi {
  invoke<C extends InvokeChannel>(channel: C, payload: InvokeMap[C]['req']): Promise<InvokeMap[C]['res']>
  on<C extends EventChannel>(channel: C, listener: (payload: EventMap[C]) => void): () => void
}
