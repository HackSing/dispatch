import { useEffect, useRef, useState } from 'react'
import type { Project, Task } from '@shared/types'
import { DEFAULT_PROJECT_ID } from '@shared/types'
import { useAppStore } from '../stores/app-store'
import { TaskEditForm } from './TaskEditForm'
import { TaskMenu } from './TaskMenu'
import { DotsIcon, GripIcon } from './icons'
import { agentChainLabel, statusBadgeLabel } from '../lib/task-labels'
import { FILTER_LABELS, matchesFilter, type TaskFilter } from '../lib/task-filters'
import { usePopoverDismiss } from '../lib/use-popover'
import { formatElapsed, formatTime } from '../lib/time'

function triggerLabel(task: Task): string {
  if (task.triggerType === 'immediate') return '触发:立即'
  if (task.triggerType === 'at') return `触发:${formatTime(task.triggerAt)}`
  return ''
}

function TaskCard(props: {
  task: Task
  onEdit: () => void
  onOpen: () => void
  onOpenTask: (taskId: string) => void
  onOpenSession: (taskId: string) => void
}): React.JSX.Element {
  const { task, onEdit, onOpen, onOpenTask } = props
  const [actionError, setActionError] = useState<string | null>(null)
  const editable = task.status === 'todo' || task.status === 'scheduled'
  const active = task.status === 'running' || task.status === 'merging'

  // 执行中耗时每秒刷新
  const [nowMs, setNowMs] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])

  const toggleTodo = (): void => {
    void window.dispatchApi
      .invoke('task:toggle-todo', { id: task.id })
      .catch((e: Error) => setActionError(e.message))
  }

  return (
    <div className="task-card">
      <input
        type="checkbox"
        className="ck"
        checked={task.status === 'done'}
        disabled={task.status !== 'todo' && task.status !== 'done'}
        title={task.status === 'todo' ? '勾选完成' : task.status === 'done' ? '取消勾选,重开为待办' : ''}
        onChange={toggleTodo}
      />
      <div className="task-body" onClick={onOpen} title="查看详情">
        <div className={`task-text${task.status === 'done' ? ' done' : ''}`}>{task.text}</div>
        <div className="badges">
          <span className={`badge ${task.status}`}>{statusBadgeLabel(task)}</span>
          {task.parentTaskId && <span className="badge relay">接力</span>}
        </div>
        <div className="info">
          {active && task.startedAt && <span>已执行 {formatElapsed(task.startedAt, nowMs)}</span>}
          {triggerLabel(task) && <span>{triggerLabel(task)}</span>}
          {task.agent && <span className="agent-chain mono">{agentChainLabel(task)}</span>}
          <span>创建:{formatTime(task.createdAt)}</span>
          {task.failReason && <span className="form-error">{task.failReason}</span>}
          {actionError && <span className="form-error">{actionError}</span>}
        </div>
      </div>
      <div className="task-actions">
        <TaskMenu
          task={task}
          onEdit={editable ? onEdit : undefined}
          onOpenTask={onOpenTask}
          onOpenSession={props.onOpenSession}
        />
      </div>
    </div>
  )
}

/** 列头 ⋯ 菜单:移除项目(仅解除登记);default 项目无可用操作,不渲染 */
function ProjectMenu(props: { project: Project }): React.JSX.Element | null {
  const { project } = props
  const refreshTasks = useAppStore((s) => s.refreshTasks)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 })
  const [error, setError] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)

  usePopoverDismiss(open, wrapRef, () => setOpen(false))

  if (project.id === DEFAULT_PROJECT_ID) return null

  const toggleOpen = (): void => {
    if (open) {
      setOpen(false)
      return
    }
    const rect = btnRef.current?.getBoundingClientRect()
    if (!rect) return
    setPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
    setOpen(true)
  }

  const remove = (): void => {
    setOpen(false)
    const confirmText = [
      `移除项目「${project.name}」?`,
      '· 仅解除登记,磁盘目录与归档保留',
      '· 已结项任务记录随项目移除',
      '· 存在未结项任务时将被拒绝'
    ].join('\n')
    if (!window.confirm(confirmText)) return
    void window.dispatchApi
      .invoke('project:remove', { id: project.id })
      // 终态任务随项目删行,project:changed 只刷项目,任务列表需一并刷新
      .then(() => refreshTasks())
      .catch((e: Error) => setError(e.message))
  }

  return (
    <div className="menu-wrap" ref={wrapRef}>
      {error && <span className="form-error">{error}</span>}
      <button
        ref={btnRef}
        className="menu-btn"
        title="项目操作"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggleOpen}
      >
        <DotsIcon />
      </button>
      {open && (
        <div className="menu-pop" role="menu" style={pos}>
          <button role="menuitem" className="menu-item danger" onClick={remove}>
            移除项目
          </button>
        </div>
      )}
    </div>
  )
}

/** 看板单列:列头(手柄/名称/进行中计数/⋯)+ 过滤后的任务卡;空列与被过滤清空各给提示 */
export function ProjectColumn(props: {
  project: Project
  tasks: Task[]
  filter: TaskFilter
  editingId: string | null
  setEditingId: (id: string | null) => void
  setDetailId: (id: string | null) => void
  onOpenSession: (taskId: string) => void
  onCreateProject: () => Promise<string | null>
}): React.JSX.Element {
  const { project, tasks, filter } = props
  const store = useAppStore()
  const visible = tasks.filter((t) => matchesFilter(t, filter))
  const activeCount = tasks.filter((t) => matchesFilter(t, 'active')).length
  const emptyHint =
    tasks.length === 0 ? '该项目暂无任务' : `无${FILTER_LABELS[filter]}任务(共 ${tasks.length} 条)`

  return (
    <section className="board-col" aria-label={project.name}>
      <div className="board-col-head" title={project.path}>
        <span className="grip">
          <GripIcon />
        </span>
        <span className="name">{project.name}</span>
        <span className="cnt">{activeCount}</span>
        <span className="spacer" />
        <ProjectMenu project={project} />
      </div>
      <div className="board-col-body">
        {visible.length === 0 ? (
          <p className="board-empty">{emptyHint}</p>
        ) : (
          visible.map((task) =>
            props.editingId === task.id ? (
              <TaskEditForm
                key={task.id}
                task={task}
                projects={store.projects}
                detections={store.detections}
                onCreateProject={props.onCreateProject}
                onClose={() => props.setEditingId(null)}
              />
            ) : (
              <TaskCard
                key={task.id}
                task={task}
                onEdit={() => props.setEditingId(task.id)}
                onOpen={() => props.setDetailId(task.id)}
                onOpenTask={props.setDetailId}
                onOpenSession={props.onOpenSession}
              />
            )
          )
        )}
      </div>
    </section>
  )
}
