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
 * - scheduled → todo:取消执行,退回普通待办
 * - running → done:非 git 项目(no_vcs)执行成功,跳过合并
 * - running/merging → failed:含崩溃恢复(interrupted)
 * - conflict/awaiting_merge → failed:用户放弃
 */
export const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  todo: ['scheduled', 'done'],
  scheduled: ['running', 'todo'],
  running: ['merging', 'done', 'failed'],
  merging: ['done', 'awaiting_merge', 'conflict', 'failed'],
  awaiting_merge: ['merging', 'failed'],
  conflict: ['merging', 'failed'],
  failed: [],
  done: []
}

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
