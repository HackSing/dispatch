import log from 'electron-log/main'
import type { Task } from '@shared/types'
import type { ExecutorDeps } from '@core/executor'
import { FollowUpSession } from '@core/executor/follow-up'
import { broadcast } from './ipc-handlers'

/**
 * 面板会话的壳层归属:活跃会话表(单 parent 同时最多一个面板)、事件→IPC 广播、
 * 应用退出统一收口。会话引擎本身不触 Electron(core 层纪律)。
 */
export class SessionService {
  /** 接力任务 id → 活跃会话 */
  private readonly sessions = new Map<string, FollowUpSession>()
  /** parent 任务 id → 接力任务 id(去重:同一任务不开第二个面板) */
  private readonly byParent = new Map<string, string>()

  constructor(private readonly deps: ExecutorDeps) {}

  async start(parentId: string): Promise<Task> {
    if (this.byParent.has(parentId)) {
      throw new Error('该任务已有进行中的面板会话')
    }
    const session = await FollowUpSession.start(this.deps, parentId, {
      onRoundStart: (task, round) =>
        broadcast('task:session-event', { taskId: task.id, kind: 'round-start', round }),
      onChunk: (taskId, text) => broadcast('task:session-event', { taskId, kind: 'chunk', text }),
      onRoundResult: (task, round, result) =>
        broadcast('task:session-event', { taskId: task.id, kind: 'round-result', round, result }),
      onClosed: (task, reason) => {
        this.sessions.delete(task.id)
        this.byParent.delete(parentId)
        broadcast('task:session-event', { taskId: task.id, kind: 'closed', reason })
      }
    })
    this.sessions.set(session.taskId, session)
    this.byParent.set(parentId, session.taskId)
    return this.deps.tasks.get(session.taskId) as Task
  }

  /** 契约:同步校验后立即返回,轮次进展与失败均经 task:session-event 广播 */
  send(taskId: string, text: string): void {
    const session = this.mustGet(taskId)
    if (!text.trim()) throw new Error('追问内容不能为空')
    if (!session.open) throw new Error('会话已关闭')
    if (session.busy) throw new Error('上一轮未结束,不可发送')
    // 轮次级失败(超时/进程退出)已由引擎落任务终态并广播 closed,此处仅记录编排日志
    void session.sendTurn(text).catch((e: Error) => {
      log.error(`会话 ${taskId} 轮次失败: ${e.message}`)
    })
  }

  finish(taskId: string): Task {
    const session = this.mustGet(taskId)
    void session.finish().catch((e: Error) => log.error(`会话 ${taskId} 完成合并异常: ${e.message}`))
    return this.deps.tasks.get(taskId) as Task
  }

  abandon(taskId: string): Task {
    const session = this.mustGet(taskId)
    void session.abandon().catch((e: Error) => log.error(`会话 ${taskId} 放弃异常: ${e.message}`))
    return this.deps.tasks.get(taskId) as Task
  }

  /** 活跃会话的工作目录(终端逃生舱对 running 面板任务用) */
  workingDirOf(taskId: string): string | null {
    return this.sessions.get(taskId)?.workingDir ?? null
  }

  get activeCount(): number {
    return this.sessions.size
  }

  /** 应用退出统一收口:杀传输,任务落 failed;5s 宽限由传输层保证 */
  async disposeAll(reason: string): Promise<void> {
    const pending = [...this.sessions.values()].map((s) =>
      s.dispose(reason).catch((e: Error) => log.error(`会话 ${s.taskId} 退出收口失败: ${e.message}`))
    )
    await Promise.all(pending)
  }

  private mustGet(taskId: string): FollowUpSession {
    const session = this.sessions.get(taskId)
    if (!session) throw new Error('该任务没有活跃的面板会话')
    return session
  }
}
