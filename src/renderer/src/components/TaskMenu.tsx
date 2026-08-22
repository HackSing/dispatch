import { useEffect, useRef, useState } from 'react'
import type { Task } from '@shared/types'
import { useAppStore } from '../stores/app-store'

/**
 * 任务操作统一入口:「⋯」下拉菜单,任务行与详情页共用(交互批 c4 修订)。
 * 按状态给出可用操作;执行中(running/merging)仅可中断,删除须先中断。
 * 各操作的确认与错误展示都收敛在此,菜单是操作文案与守卫的渲染层唯一来源。
 */

interface MenuItem {
  key: string
  label: string
  title?: string
  danger?: boolean
  confirm?: string
  action: () => Promise<void>
}

/** 接力链后代(含多级),删除说明与级联提示依据;store.tasks 内存展开 */
function collectDescendants(tasks: Task[], rootId: string): Task[] {
  const out: Task[] = []
  const walk = (id: string): void => {
    for (const child of tasks.filter((t) => t.parentTaskId === id)) {
      out.push(child)
      walk(child.id)
    }
  }
  walk(rootId)
  return out
}

/** 删除确认说明:删什么、级联几条、未合并改动与 worktree 怎么处理、归档保留 */
function deleteConfirmText(task: Task, descendants: Task[]): string {
  const chain = [task, ...descendants]
  const lines = ['删除该任务?此操作不可恢复。', '· 任务记录将从列表移除,磁盘归档目录保留']
  if (descendants.length > 0) lines.push(`· 将级联删除 ${descendants.length} 条接力会话记录`)
  if (chain.some((t) => t.status === 'conflict' || t.status === 'awaiting_merge')) {
    lines.push('· 存在未合并的改动,删除等同放弃合并(改动随任务分支删除)')
  }
  if (chain.some((t) => t.worktreePath !== null)) {
    lines.push('· 遗留 worktree 与任务分支将一并清理')
  }
  return lines.join('\n')
}

export function TaskMenu(props: {
  task: Task
  /** 行内编辑入口;详情页不提供 */
  onEdit?: () => void
  onOpenTask?: (taskId: string) => void
  onOpenSession?: (taskId: string) => void
}): React.JSX.Element | null {
  const { task, onEdit, onOpenTask, onOpenSession } = props
  const tasks = useAppStore((s) => s.tasks)
  const capabilities = useAppStore((s) => s.capabilities)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    // capture 阶段拦截 Esc:菜单开着时只收起菜单,不联动关闭详情抽屉
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const invoke = window.dispatchApi.invoke.bind(window.dispatchApi)
  const capability = task.agent ? capabilities?.[task.agent] : undefined
  const settled = task.status === 'done' || task.status === 'failed'
  const items: MenuItem[] = []

  if (task.status === 'todo' || task.status === 'done') {
    items.push({
      key: 'toggle',
      label: task.status === 'todo' ? '标记完成' : '重开为待办',
      action: async () => void (await invoke('task:toggle-todo', { id: task.id }))
    })
  }
  if (task.status === 'scheduled') {
    items.push(
      {
        key: 'run-now',
        label: '立即执行',
        title: '跳过等待,立即执行',
        action: async () => void (await invoke('task:run-now', { id: task.id }))
      },
      {
        key: 'cancel',
        label: '取消执行',
        title: '退回普通待办',
        action: async () => void (await invoke('task:cancel', { id: task.id }))
      }
    )
  }
  if ((task.status === 'todo' || task.status === 'scheduled') && onEdit) {
    items.push({ key: 'edit', label: '编辑', action: async () => onEdit() })
  }
  if (task.status === 'running' && task.parentTaskId === null) {
    items.push({
      key: 'interrupt',
      label: '中断',
      danger: true,
      title: '终止进行中的 agent,任务转失败(可重跑/继续对话)',
      confirm: '中断该任务?进行中的 agent 将被终止,任务标记为失败;之后可重跑或继续对话。',
      action: async () => void (await invoke('task:interrupt', { id: task.id }))
    })
  }
  if (task.status === 'running' && task.parentTaskId !== null && onOpenSession) {
    items.push({
      key: 'reattach',
      label: '打开会话面板',
      action: async () => onOpenSession(task.id)
    })
  }
  if (settled && task.sessionId && capability?.followUp && onOpenSession) {
    items.push({
      key: 'follow-up',
      label: '继续对话',
      title: '在原会话上继续多轮打磨(新工作区,结束时一次合并)',
      action: async () => {
        const follow = await invoke('task:follow-up-start', { parentId: task.id })
        onOpenSession(follow.id)
      }
    })
  }
  if (task.sessionId && capability?.terminal) {
    items.push({
      key: 'terminal',
      label: '在终端打开会话',
      title: '交互式续接该会话(改动不经 Dispatch 管线)',
      action: async () => void (await invoke('task:open-session-terminal', { id: task.id }))
    })
  }
  if (task.status === 'failed') {
    items.push({
      key: 'rerun',
      label: '重跑',
      title: '原地重新入队执行',
      action: async () => {
        const rerun = await invoke('task:rerun', { id: task.id })
        onOpenTask?.(rerun.id)
      }
    })
    if (task.worktreePath) {
      items.push({
        key: 'cleanup',
        label: '清理 worktree',
        confirm: '删除该任务遗留的 worktree 与任务分支?归档不受影响。',
        action: async () => void (await invoke('task:cleanup-worktree', { id: task.id }))
      })
    }
  }
  if (task.status === 'conflict' || task.status === 'awaiting_merge') {
    items.push(
      {
        key: 'retry-merge',
        label: task.status === 'conflict' ? '已解决,重试合并' : '重试合并',
        title:
          task.status === 'conflict' ? '已在 worktree 手动解决冲突后重试合并' : '主工作区清理后重试合并',
        action: async () => void (await invoke('task:retry-merge', { id: task.id }))
      },
      {
        key: 'abandon',
        label: '放弃',
        danger: true,
        confirm: '放弃该任务?将标记为失败,并删除其 worktree 与任务分支(归档保留)。',
        action: async () => void (await invoke('task:abandon', { id: task.id }))
      }
    )
  }
  if (task.status !== 'running' && task.status !== 'merging') {
    const descendants = collectDescendants(tasks, task.id)
    items.push({
      key: 'delete',
      label: descendants.length > 0 ? `删除(含 ${descendants.length} 条接力)` : '删除',
      danger: true,
      confirm: deleteConfirmText(task, descendants),
      action: async () => void (await invoke('task:delete', { id: task.id }))
    })
  }

  if (items.length === 0) return null

  const select = (item: MenuItem): void => {
    setOpen(false)
    if (item.confirm && !window.confirm(item.confirm)) return
    setBusy(true)
    setError(null)
    void item
      .action()
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }

  return (
    <div className="menu-wrap" ref={wrapRef}>
      {error && <span className="form-error">{error}</span>}
      <button
        className="btn menu-btn"
        disabled={busy}
        title="任务操作"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          {items.map((item) => (
            <button
              key={item.key}
              role="menuitem"
              className={`menu-item${item.danger ? ' danger' : ''}`}
              title={item.title}
              onClick={() => select(item)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
