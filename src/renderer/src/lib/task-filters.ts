import type { Task, TaskStatus } from '@shared/types'

/** 清单过滤档(App 分段控件与看板列共用):进行中 = 未走到 done/failed 的全部状态 */
export const TASK_FILTERS = ['active', 'ended', 'all'] as const
export type TaskFilter = (typeof TASK_FILTERS)[number]

export const FILTER_LABELS: Record<TaskFilter, string> = {
  active: '进行中',
  ended: '已结束',
  all: '全部'
}

const ENDED_STATUSES: readonly TaskStatus[] = ['done', 'failed']

export function matchesFilter(task: Task, filter: TaskFilter): boolean {
  if (filter === 'all') return true
  const ended = ENDED_STATUSES.includes(task.status)
  return filter === 'ended' ? ended : !ended
}
