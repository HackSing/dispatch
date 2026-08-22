import { useState } from 'react'
import type { Task } from '@shared/types'
import { useAppStore } from '../stores/app-store'

/**
 * failed/conflict/awaiting_merge 的操作按钮组,任务行与详情页共用。
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
      const copy = await window.dispatchApi.invoke('task:rerun', { id: task.id })
      await useAppStore.getState().refreshTasks()
      onOpenTask?.(copy.id)
    })

  const retryMerge = (): void =>
    run(async () => {
      await window.dispatchApi.invoke('task:retry-merge', { id: task.id })
    })

  const abandon = (): void => {
    if (!window.confirm('放弃该任务?将标记为失败,worktree 保留待清理。')) return
    run(async () => {
      await window.dispatchApi.invoke('task:abandon', { id: task.id })
    })
  }

  if (task.status !== 'failed' && task.status !== 'conflict' && task.status !== 'awaiting_merge') {
    return null
  }
  return (
    <>
      {task.status === 'failed' && (
        <button className="btn" disabled={busy} title="复制任务重新入队执行" onClick={rerun}>
          重跑
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
