import type { Task } from '@shared/types'
import type { TaskStore } from '@core/db'

export interface SchedulerDeps {
  tasks: TaskStore
  /** 入队执行(fire-and-forget),错误处理由注入方负责,调度器不吞不管 */
  enqueue: (taskId: string) => void
  /** awaiting_merge 周期重试入口(fire-and-forget),同上 */
  retryMerge: (taskId: string) => void
  /** 测试注入假时钟;缺省真实时钟 */
  now?: () => Date
  /** 扫描周期,spec §9 默认 30s */
  intervalMs?: number
  /** awaiting_merge 单任务重试最小间隔 */
  mergeRetryMs?: number
}

const DEFAULT_INTERVAL_MS = 30_000
const DEFAULT_MERGE_RETRY_MS = 60_000

/**
 * spec §9 调度器:setInterval 周期扫描(不引 cron 库),状态一律读库,
 * 到点判定与重试节流全部基于可注入时钟,tick() 可被测试直接驱动。
 */
export class Scheduler {
  private readonly now: () => Date
  private readonly intervalMs: number
  private readonly mergeRetryMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  /** 已入队未落定(仍显示 scheduled)的任务,防止跨 tick 重复入队 */
  private readonly inFlight = new Set<string>()
  /** taskId → 上次重试合并时刻(epoch ms) */
  private readonly mergeAttemptAt = new Map<string, number>()

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? (() => new Date())
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
    this.mergeRetryMs = deps.mergeRetryMs ?? DEFAULT_MERGE_RETRY_MS
  }

  /** 启动即 tick 一次(捡漏残留的到点任务),重复 start 幂等 */
  start(): void {
    if (this.timer) return
    this.tick()
    this.timer = setInterval(() => this.tick(), this.intervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  /** 恢复链路等外部入口经此入队,与 tick 共享 in-flight 去重 */
  enqueueNow(taskId: string): void {
    if (this.inFlight.has(taskId)) return
    this.inFlight.add(taskId)
    this.deps.enqueue(taskId)
  }

  tick(): void {
    const nowMs = this.now().getTime()
    this.scanScheduled(nowMs)
    this.scanAwaitingMerge(nowMs)
  }

  private scanScheduled(nowMs: number): void {
    const scheduled = this.deps.tasks.listByStatus('scheduled')
    const scheduledIds = new Set(scheduled.map((t) => t.id))
    // 已离开 scheduled 即视为落定;scheduled→todo→scheduled 循环后允许重新入队
    for (const id of this.inFlight) {
      if (!scheduledIds.has(id)) this.inFlight.delete(id)
    }
    for (const task of scheduled) {
      if (this.isDue(task, nowMs)) this.enqueueNow(task.id)
    }
  }

  private isDue(task: Task, nowMs: number): boolean {
    // immediate 常规在创建时即入队,这里兜底崩溃/漏接的残留
    if (task.triggerType === 'immediate') return true
    if (task.triggerType !== 'at' || !task.triggerAt) return false
    return Date.parse(task.triggerAt) <= nowMs
  }

  private scanAwaitingMerge(nowMs: number): void {
    const awaiting = this.deps.tasks.listByStatus('awaiting_merge')
    const awaitingIds = new Set(awaiting.map((t) => t.id))
    // 节流表只回收已终局的任务;merging 窗口内保留,避免 tick 恰逢重试中导致节流失效
    for (const id of this.mergeAttemptAt.keys()) {
      if (awaitingIds.has(id)) continue
      const task = this.deps.tasks.get(id)
      if (!task || task.status === 'done' || task.status === 'failed') {
        this.mergeAttemptAt.delete(id)
      }
    }
    for (const task of awaiting) {
      const last = this.mergeAttemptAt.get(task.id)
      if (last !== undefined && nowMs - last < this.mergeRetryMs) continue
      this.mergeAttemptAt.set(task.id, nowMs)
      this.deps.retryMerge(task.id)
    }
  }
}

export { recoverOnStartup } from './recovery'
export type { RecoveryDeps, RecoveryReport } from './recovery'
