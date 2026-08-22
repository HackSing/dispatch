import { useState } from 'react'
import type { Task } from '@shared/types'
import { useAppStore } from '../stores/app-store'

/**
 * 手动状态切换按钮(todo→完成 / done→重开),任务行与详情页共用;
 * 与勾选框走同一 task:toggle-todo 通道,只是给状态更新一个显式可发现的入口。
 */
export function ToggleTodoButton(props: {
  task: Task
  /** 详情页用完整文案(标记完成/重开为待办),行内用短文案(完成/重开) */
  verbose?: boolean
}): React.JSX.Element | null {
  const { task, verbose } = props
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (task.status !== 'todo' && task.status !== 'done') return null
  const isTodo = task.status === 'todo'
  const label = isTodo ? (verbose ? '标记完成' : '完成') : verbose ? '重开为待办' : '重开'
  const toggle = (): void => {
    setBusy(true)
    setError(null)
    void window.dispatchApi
      .invoke('task:toggle-todo', { id: task.id })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }
  return (
    <>
      <button
        className="btn"
        disabled={busy}
        title={isTodo ? '标记为已完成(与勾选框等效)' : '取消完成,重开为待办'}
        onClick={toggle}
      >
        {label}
      </button>
      {error && <span className="form-error">{error}</span>}
    </>
  )
}

/**
 * running(可中断)/failed/conflict/awaiting_merge 的操作按钮组,任务行与详情页共用。
 * task:retry-merge 的 handler 由合并线注册,未注册时的报错在此 catch 后原样展示。
 */
export function TaskOps(props: {
  task: Task
  onOpenTask?: (taskId: string) => void
}): React.JSX.Element | null {
  const { task, onOpenTask } = props
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = (fn: () => Promise<void>): void => {
    setBusy(true)
    setError(null)
    void fn()
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }

  const rerun = (): void =>
    run(async () => {
      const task2 = await window.dispatchApi.invoke('task:rerun', { id: task.id })
      await useAppStore.getState().refreshTasks()
      onOpenTask?.(task2.id)
    })

  const interrupt = (): void => {
    if (!window.confirm('中断该任务?进行中的 agent 将被终止,任务标记为失败;之后可重跑或继续对话。'))
      return
    run(() => window.dispatchApi.invoke('task:interrupt', { id: task.id }))
  }

  const retryMerge = (): void =>
    run(async () => {
      await window.dispatchApi.invoke('task:retry-merge', { id: task.id })
    })

  const abandon = (): void => {
    if (!window.confirm('放弃该任务?将标记为失败,并删除其 worktree 与任务分支(归档保留)。'))
      return
    run(async () => {
      await window.dispatchApi.invoke('task:abandon', { id: task.id })
    })
  }

  const cleanupWorktree = (): void => {
    if (!window.confirm('删除该任务遗留的 worktree 与任务分支?归档不受影响。')) return
    run(async () => {
      await window.dispatchApi.invoke('task:cleanup-worktree', { id: task.id })
    })
  }

  // running 面板接力任务的终止归面板;其余 running 提供中断
  const interruptible = task.status === 'running' && task.parentTaskId === null
  if (
    !interruptible &&
    task.status !== 'failed' &&
    task.status !== 'conflict' &&
    task.status !== 'awaiting_merge'
  ) {
    return null
  }
  return (
    <>
      {interruptible && (
        <button
          className="btn danger"
          disabled={busy}
          title="终止进行中的 agent,任务转失败(可重跑/继续对话)"
          onClick={interrupt}
        >
          中断
        </button>
      )}
      {task.status === 'failed' && (
        <button className="btn" disabled={busy} title="复制任务重新入队执行" onClick={rerun}>
          重跑
        </button>
      )}
      {task.status === 'failed' && task.worktreePath && (
        <button
          className="btn"
          disabled={busy}
          title="删除遗留 worktree 与任务分支,归档保留"
          onClick={cleanupWorktree}
        >
          清理 worktree
        </button>
      )}
      {task.status === 'conflict' && (
        <button
          className="btn"
          disabled={busy}
          title="已在 worktree 手动解决冲突后重试合并"
          onClick={retryMerge}
        >
          已解决,重试合并
        </button>
      )}
      {task.status === 'awaiting_merge' && (
        <button className="btn" disabled={busy} title="主工作区清理后重试合并" onClick={retryMerge}>
          重试合并
        </button>
      )}
      {(task.status === 'conflict' || task.status === 'awaiting_merge') && (
        <button className="btn danger" disabled={busy} title="放弃任务,标记为失败" onClick={abandon}>
          放弃
        </button>
      )}
      {error && <span className="form-error">{error}</span>}
    </>
  )
}
