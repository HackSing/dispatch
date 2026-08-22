import type { Task } from '@shared/types'
import type { ProjectStore } from './db/project-store'
import type { EditableTaskPatch, TaskStore } from './db/task-store'
import { cleanupTaskWorkspace, removeTaskWorktreeAndBranch } from './executor/cleanup'

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

/** 删除链 = 自身 + 全部接力后代(深度优先展开;环由 FK 结构排除) */
function collectDeleteChain(store: TaskStore, id: string): Task[] {
  const root = store.get(id)
  if (!root) throw new Error(`task not found: ${id}`)
  const chain: Task[] = []
  const walk = (task: Task): void => {
    chain.push(task)
    for (const child of store.listChildren(task.id)) walk(child)
  }
  walk(root)
  return chain
}

const EXECUTING: readonly string[] = ['running', 'merging']

export interface DeletePreview {
  /** 含自身;删除按此逆序(先后代)执行 */
  chain: Task[]
  /** 链上有未合并改动的任务(conflict/awaiting_merge),删除等同放弃合并 */
  unmerged: Task[]
  /** 链上有遗留 worktree 待一并清理的任务 */
  withWorktree: Task[]
}

/** 删除前预览(确认弹窗的说明文案依据);链上有执行中任务时抛错 */
export function previewDelete(store: TaskStore, id: string): DeletePreview {
  const chain = collectDeleteChain(store, id)
  const executing = chain.find((t) => EXECUTING.includes(t.status))
  if (executing) {
    throw new Error(
      executing.id === id
        ? `任务状态 ${executing.status} 不可删除,请先中断`
        : '该任务的接力会话仍在执行,请先终止或等待结束'
    )
  }
  return {
    chain,
    unmerged: chain.filter((t) => t.status === 'conflict' || t.status === 'awaiting_merge'),
    withWorktree: chain.filter((t) => t.worktreePath !== null)
  }
}

/**
 * 删除任务及其接力链(用户裁决,不可恢复;磁盘归档永久保留):
 * 逐个(先后代后自身)清理 worktree 与任务分支后删行——不经状态迁移,
 * 避免删除前触发误导性的失败通知。广播由壳层在完成后显式发出。
 */
export async function deleteTask(
  stores: { tasks: TaskStore; projects: ProjectStore },
  id: string
): Promise<void> {
  const { chain } = previewDelete(stores.tasks, id)
  for (const task of [...chain].reverse()) {
    if (task.worktreePath) {
      const project = stores.projects.get(task.projectId)
      if (!project) throw new Error(`任务关联项目不存在: ${task.projectId}`)
      await removeTaskWorktreeAndBranch(project, task)
    }
    stores.tasks.delete(task.id)
  }
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
