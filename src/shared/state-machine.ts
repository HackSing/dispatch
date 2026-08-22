/** 任务状态机唯一定义(spec §4.2)。所有状态写入必须经 TaskStore.transition() 走此校验。 */

export const TASK_STATUSES = [
  'todo',
  'scheduled',
  'running',
  'merging',
  'awaiting_merge',
  'conflict',
  'failed',
  'done'
] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]

/**
 * 合法迁移表。
 * - todo → done:普通待办手动勾选
 * - done → todo:手动重开(勾错回退/完成后再改再跑);执行期历史字段保留不清
 * - scheduled → todo:取消执行,退回普通待办
 * - running → done:非 git 项目(no_vcs)执行成功,跳过合并
 * - running/merging → failed:含崩溃恢复(interrupted)
 * - conflict/awaiting_merge → failed:用户放弃
 * - failed → scheduled:原地重跑(清执行期字段后重新入队,不复制新任务行;
 *   历史归档留盘,旧记录不在列表堆积)
 */
export const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  todo: ['scheduled', 'done'],
  scheduled: ['running', 'todo'],
  running: ['merging', 'done', 'failed'],
  merging: ['done', 'awaiting_merge', 'conflict', 'failed'],
  awaiting_merge: ['merging', 'failed'],
  conflict: ['merging', 'failed'],
  failed: ['scheduled'],
  done: ['todo']
}

/**
 * 已结算态:任务生命周期已走完,不再被调度器/执行器推进。
 * 不能从「无出边」推导——done 保留手动重开边(done→todo)但仍是已结算;
 * 项目删除等"任务是否了结"的判定一律以此清单为准(单一来源)。
 */
export const SETTLED_STATUSES: readonly TaskStatus[] = ['done', 'failed']

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: TaskStatus,
    public readonly to: TaskStatus
  ) {
    super(`illegal task transition: ${from} -> ${to}`)
    this.name = 'IllegalTransitionError'
  }
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to)
}
