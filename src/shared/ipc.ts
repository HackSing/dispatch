/** IPC 通道契约唯一来源:preload 与主进程 handler 均从此派生,禁止手写字符串 channel。 */

import type { TaskStatus } from './state-machine'

export interface AppStatus {
  version: string
  dbSchemaVersion: number
  dispatchHome: string
  platform: NodeJS.Platform
}

/** invoke 型通道:渲染层请求 → 主进程响应 */
export interface InvokeMap {
  'app:status': { req: void; res: AppStatus }
}

/** 事件型通道:主进程广播 → 渲染层订阅 */
export interface EventMap {
  'task:changed': { taskId: string; status: TaskStatus }
}

export type InvokeChannel = keyof InvokeMap
export type EventChannel = keyof EventMap

export const INVOKE_CHANNELS: readonly InvokeChannel[] = ['app:status']
export const EVENT_CHANNELS: readonly EventChannel[] = ['task:changed']

/** preload 暴露到 window.dispatchApi 的形状 */
export interface DispatchApi {
  invoke<C extends InvokeChannel>(channel: C, payload: InvokeMap[C]['req']): Promise<InvokeMap[C]['res']>
  on<C extends EventChannel>(channel: C, listener: (payload: EventMap[C]) => void): () => void
}
