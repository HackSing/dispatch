import log from 'electron-log/main'
import type { Task } from '@shared/types'
import type { ExecutorDeps } from '@core/executor'
import { FollowUpSession } from '@core/executor/follow-up'
import { PlanDiscussionSession } from '@core/executor/plan-discussion'
import { broadcast } from './ipc-handlers'

/**
 * 面板会话的壳层归属:追写面板会话表(单 parent 同时最多一个面板)、方案讨论会话表(按 taskId 去重,
 * 与追写表相互独立)、事件→IPC 广播、应用退出统一收口。会话引擎本身不触 Electron(core 层纪律)。
 */
export class SessionService {
  /** 接力任务 id → 活跃追写面板会话 */
  private readonly sessions = new Map<string, FollowUpSession>()
  /** parent 任务 id → 接力任务 id(去重:同一任务不开第二个面板) */
  private readonly byParent = new Map<string, string>()
  /** awaiting_confirm 任务 id → 活跃方案讨论会话(按 taskId 去重) */
  private readonly discussions = new Map<string, PlanDiscussionSession>()

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
    // 轮次级失败(超时/进程退出/首轮模板渲染)已由引擎落任务终态并广播 closed,此处仅记录编排日志
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

  /**
   * 开启方案讨论会话(幂等:同一任务已开着直接返回)。进展与失败均经 task:session-event 广播;
   * onClosed 只从讨论表摘除并广播,绝不迁移任务状态(任务保持 awaiting_confirm)。
   * 返回当前轮次忙碌态,供详情页重开时恢复输入闸门(busy 不进任务状态,重开详情只能靠此拿回)。
   */
  async openPlanDiscussion(taskId: string): Promise<{ busy: boolean }> {
    const existing = this.discussions.get(taskId)
    if (existing) return { busy: existing.busy }
    const session = await PlanDiscussionSession.start(this.deps, taskId, {
      onRoundStart: (task, round) =>
        broadcast('task:session-event', { taskId: task.id, kind: 'round-start', round }),
      onChunk: (id, text) => broadcast('task:session-event', { taskId: id, kind: 'chunk', text }),
      onRoundResult: (task, round, result) =>
        broadcast('task:session-event', { taskId: task.id, kind: 'round-result', round, result }),
      onClosed: (task, reason) => {
        this.discussions.delete(task.id)
        broadcast('task:session-event', { taskId: task.id, kind: 'closed', reason })
      }
    })
    this.discussions.set(taskId, session)
    return { busy: session.busy }
  }

  /** 契约:同步校验后立即返回,轮次进展与失败均经 task:session-event 广播 */
  sendPlanDiscussion(taskId: string, text: string): void {
    const session = this.discussions.get(taskId)
    if (!session) throw new Error('该任务没有进行中的方案讨论')
    if (!text.trim()) throw new Error('讨论内容不能为空')
    if (!session.open) throw new Error('讨论已关闭')
    if (session.busy) throw new Error('上一轮未结束,不可发送')
    // 轮级失败已由引擎关会话并广播 closed(不动任务状态),此处仅记录编排日志
    void session.sendTurn(text).catch((e: Error) => {
      log.error(`方案讨论 ${taskId} 轮次失败: ${e.message}`)
    })
  }

  /** 关闭方案讨论会话(幂等:未开着为 no-op)。只关传输,不迁移任务状态 */
  closePlanDiscussion(taskId: string): void {
    const session = this.discussions.get(taskId)
    if (!session) return
    void session.close().catch((e: Error) => log.error(`方案讨论 ${taskId} 关闭异常: ${e.message}`))
  }

  /** 活跃会话的工作目录(终端逃生舱对 running 面板任务用) */
  workingDirOf(taskId: string): string | null {
    return this.sessions.get(taskId)?.workingDir ?? null
  }

  /** 追写面板 + 方案讨论均计入:before-quit 收口门以此判定是否需等待传输收尾 */
  get activeCount(): number {
    return this.sessions.size + this.discussions.size
  }

  /**
   * 应用退出统一收口:追写会话 dispose(落 failed,因接力任务在 running);
   * 方案讨论 close(只关传输,任务保持 awaiting_confirm——无在跑执行进程,不得落 failed)。5s 宽限由传输层保证。
   */
  async disposeAll(reason: string): Promise<void> {
    const pending = [
      ...[...this.sessions.values()].map((s) =>
        s.dispose(reason).catch((e: Error) => log.error(`会话 ${s.taskId} 退出收口失败: ${e.message}`))
      ),
      ...[...this.discussions.values()].map((s) =>
        s.close().catch((e: Error) => log.error(`方案讨论 ${s.taskId} 退出收口失败: ${e.message}`))
      )
    ]
    await Promise.all(pending)
  }

  private mustGet(taskId: string): FollowUpSession {
    const session = this.sessions.get(taskId)
    if (!session) throw new Error('该任务没有活跃的面板会话')
    return session
  }
}
