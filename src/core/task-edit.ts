import type { Task } from '@shared/types'
import type { EditableTaskPatch, TaskStore } from './db/task-store'

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

export function completeTodo(store: TaskStore, id: string): Task {
  const current = store.get(id)
  if (!current) throw new Error(`task not found: ${id}`)
  if (current.status !== 'todo') throw new Error('仅 todo 任务可勾选完成')
  return store.transition(id, 'done', { finishedAt: new Date().toISOString() })
}

/** 取消执行退回普通待办;agent 保留作为下次升级的默认值 */
export function cancelScheduled(store: TaskStore, id: string): Task {
  const current = store.get(id)
  if (!current) throw new Error(`task not found: ${id}`)
  if (current.status !== 'scheduled') throw new Error('仅 scheduled 任务可取消')
  store.transition(id, 'todo', { scheduledAt: null })
  return store.updateEditable(id, { triggerType: 'none', triggerAt: null })
}

/** 失败重跑 = 复制 text/projectId/agent 为新任务立即入队(spec §3.2);原任务保持 failed 终态 */
export function rerunFailedTask(store: TaskStore, id: string): Task {
  const current = store.get(id)
  if (!current) throw new Error(`task not found: ${id}`)
  if (current.status !== 'failed') throw new Error(`仅 failed 任务可重跑,当前状态 ${current.status}`)
  if (!current.agent) throw new Error('原任务缺少 agent,无法重跑')
  return store.create({
    text: current.text,
    projectId: current.projectId,
    agent: current.agent,
    triggerType: 'immediate'
  })
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
