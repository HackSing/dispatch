import type { Task } from '@shared/types'
import type { ProjectStore } from './db/project-store'
import type { EditableTaskPatch, TaskStore } from './db/task-store'
import { cleanupTaskWorkspace } from './executor/cleanup'

/**
 * 任务编辑统一编排:字段更新走 updateEditable(),状态升降级走 transition(),
 * trigger 变化自动触发 todo↔scheduled 迁移,渲染层不感知状态机细节。
 */
export function editTask(store: TaskStore, id: string, patch: EditableTaskPatch): Task {
  const current = store.get(id)
  if (!current) throw new Error(`task not found: ${id}`)
  if (current.status !== 'todo' && current.status !== 'scheduled') {
    throw new Error(`任务状态 ${current.status} 不可编辑`)
  }
  const nextTrigger = patch.triggerType ?? current.triggerType
  let task = store.updateEditable(id, patch)
  if (current.status === 'todo' && nextTrigger !== 'none') {
    task = store.transition(id, 'scheduled', { scheduledAt: new Date().toISOString() })
  } else if (current.status === 'scheduled' && nextTrigger === 'none') {
    task = store.transition(id, 'todo', { scheduledAt: null })
  }
  return task
}

/** 双向勾选:todo → done(完成)/ done → todo(重开);执行期历史字段保留不清 */
export function toggleTodo(store: TaskStore, id: string): Task {
  const current = store.get(id)
  if (!current) throw new Error(`task not found: ${id}`)
  if (current.status === 'todo') {
    return store.transition(id, 'done', { finishedAt: new Date().toISOString() })
  }
  if (current.status === 'done') return store.transition(id, 'todo')
  throw new Error(`仅 todo/done 任务可勾选切换,当前状态 ${current.status}`)
}

/** 取消执行退回普通待办;agent 保留作为下次升级的默认值 */
export function cancelScheduled(store: TaskStore, id: string): Task {
  const current = store.get(id)
  if (!current) throw new Error(`task not found: ${id}`)
  if (current.status !== 'scheduled') throw new Error('仅 scheduled 任务可取消')
  store.transition(id, 'todo', { scheduledAt: null })
  return store.updateEditable(id, { triggerType: 'none', triggerAt: null })
}

/**
 * 失败重跑 = 原地重新入队(交互批 c4 修订,取代 spec §3.2 的复制语义):
 * 清理遗留 worktree → 清执行期字段 → failed→scheduled。列表不再堆积失败副本;
 * 上一轮归档留盘(重跑得到新归档目录,createArchive 撞名自动加后缀)。
 */
export async function rerunFailedTask(
  stores: { tasks: TaskStore; projects: ProjectStore },
  id: string
): Promise<Task> {
  const current = stores.tasks.get(id)
  if (!current) throw new Error(`task not found: ${id}`)
  if (current.status !== 'failed') throw new Error(`仅 failed 任务可重跑,当前状态 ${current.status}`)
  if (!current.agent) throw new Error('原任务缺少 agent,无法重跑')
  await cleanupTaskWorkspace(stores, id)
  stores.tasks.prepareRerun(id)
  return stores.tasks.transition(id, 'scheduled', { scheduledAt: new Date().toISOString() })
}

/** 放弃 conflict/awaiting_merge → failed(abandoned);worktree 保留,由清理策略延后回收 */
export function abandonTask(store: TaskStore, id: string): Task {
  const current = store.get(id)
  if (!current) throw new Error(`task not found: ${id}`)
  if (current.status !== 'conflict' && current.status !== 'awaiting_merge') {
    throw new Error(`仅 conflict/awaiting_merge 任务可放弃,当前状态 ${current.status}`)
  }
  return store.transition(id, 'failed', {
    failReason: 'abandoned',
    finishedAt: current.finishedAt ?? new Date().toISOString()
  })
}
