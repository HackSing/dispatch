import { existsSync } from 'node:fs'
import type { Project, Task } from '@shared/types'
import type { ProjectStore, TaskStore } from '@core/db'
import { deleteBranchIfExists, pruneWorktrees, removeWorktree } from '@core/gitops'

export interface CleanupDeps {
  tasks: TaskStore
  projects: ProjectStore
}

/** git 清理内核(worktree + 任务分支),状态守卫与字段清空由调用方各自负责;可重入 */
export async function removeTaskWorktreeAndBranch(project: Project, task: Task): Promise<void> {
  if (!task.worktreePath) return
  if (existsSync(task.worktreePath) && task.branch) {
    await removeWorktree(project.path, task.worktreePath, task.branch)
  } else {
    await pruneWorktrees(project.path)
    if (task.branch) await deleteBranchIfExists(project.path, task.branch)
  }
}

/**
 * 清理 failed 终态任务遗留的 worktree 与任务分支,归档不动(归档永久保留,spec §8.3)。
 * done 的清理在合并链路内完成;conflict/awaiting_merge 的 worktree 是重试合并的前提,拒绝清理。
 * 可重入:worktree 目录已消失则 prune 登记残留,分支不存在为 no-op。
 */
export async function cleanupTaskWorkspace(deps: CleanupDeps, taskId: string): Promise<Task> {
  const task = deps.tasks.get(taskId)
  if (!task) throw new Error(`任务不存在: ${taskId}`)
  if (task.status !== 'failed') {
    throw new Error(`任务状态 ${task.status} 不可清理 worktree(仅 failed)`)
  }
  if (!task.worktreePath) return task
  const project = deps.projects.get(task.projectId)
  if (!project) throw new Error(`任务关联项目不存在: ${task.projectId}`)

  await removeTaskWorktreeAndBranch(project, task)
  return deps.tasks.clearWorktreePath(taskId)
}
