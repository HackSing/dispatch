import { useEffect, useMemo, useState } from 'react'
import type { Task, TaskStatus } from '@shared/types'
import { useAppStore } from './stores/app-store'
import { TaskEditForm } from './components/TaskEditForm'
import { TaskDetail } from './components/TaskDetail'
import { SessionPanel } from './components/SessionPanel'
import { TaskOps, ToggleTodoButton } from './components/TaskOps'
import { pickAndCreateProject } from './lib/projects'
import { agentChainLabel, statusBadgeLabel } from './lib/task-labels'
import { formatElapsed, formatTime } from './lib/time'

function triggerLabel(task: Task): string {
  if (task.triggerType === 'immediate') return '触发:立即'
  if (task.triggerType === 'at') return `触发:${formatTime(task.triggerAt)}`
  return ''
}

/** 清单页过滤档:进行中 = 未走到 done/failed 的全部状态 */
const TASK_FILTERS = ['active', 'ended', 'all'] as const
type TaskFilter = (typeof TASK_FILTERS)[number]

const FILTER_LABELS: Record<TaskFilter, string> = { active: '进行中', ended: '已结束', all: '全部' }

const ENDED_STATUSES: readonly TaskStatus[] = ['done', 'failed']

function matchesFilter(task: Task, filter: TaskFilter): boolean {
  if (filter === 'all') return true
  const ended = ENDED_STATUSES.includes(task.status)
  return filter === 'ended' ? ended : !ended
}

function TaskRow(props: {
  task: Task
  onEdit: () => void
  onOpen: () => void
  onOpenTask: (taskId: string) => void
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

  const run = (fn: () => Promise<unknown>): void => {
    void fn().catch((e: Error) => setActionError(e.message))
  }

  return (
    <div className="task-row">
      <input
        type="checkbox"
        checked={task.status === 'done'}
        disabled={task.status !== 'todo' && task.status !== 'done'}
        title={task.status === 'todo' ? '勾选完成' : task.status === 'done' ? '取消勾选,重开为待办' : ''}
        onChange={() => run(() => window.dispatchApi.invoke('task:toggle-todo', { id: task.id }))}
      />
      <div className="task-body" onClick={onOpen} title="查看详情">
        <div className={`task-text${task.status === 'done' ? ' done' : ''}`}>{task.text}</div>
        <div className="task-meta">
          <span className={`badge ${task.status}`}>{statusBadgeLabel(task)}</span>
          {task.parentTaskId && <span className="badge relay">接力</span>}
          {active && task.startedAt && <span>已执行 {formatElapsed(task.startedAt, nowMs)}</span>}
          {triggerLabel(task) && <span>{triggerLabel(task)}</span>}
          {task.agent && <span className="agent-chain">{agentChainLabel(task)}</span>}
          <span>创建:{formatTime(task.createdAt)}</span>
          {task.failReason && <span className="form-error">{task.failReason}</span>}
          {actionError && <span className="form-error">{actionError}</span>}
        </div>
      </div>
      <div className="task-actions">
        <ToggleTodoButton task={task} />
        {editable && (
          <button className="btn" onClick={onEdit}>
            编辑
          </button>
        )}
        {task.status === 'scheduled' && (
          <>
            <button
              className="btn"
              title="跳过等待,立即执行"
              onClick={() => run(() => window.dispatchApi.invoke('task:run-now', { id: task.id }))}
            >
              立即执行
            </button>
            <button
              className="btn"
              title="取消执行,退回普通待办"
              onClick={() => run(() => window.dispatchApi.invoke('task:cancel', { id: task.id }))}
            >
              取消
            </button>
          </>
        )}
        <TaskOps task={task} onOpenTask={onOpenTask} />
      </div>
    </div>
  )
}

/** 单项目分组:折叠头(计数常显)+ 过滤后的任务卡;空项目与被过滤清空各给提示 */
function ProjectSection(props: {
  project: { id: string; name: string; path: string }
  tasks: Task[]
  filter: TaskFilter
  collapsed: boolean
  onToggleCollapsed: () => void
  editingId: string | null
  setEditingId: (id: string | null) => void
  setDetailId: (id: string | null) => void
  onCreateProject: () => Promise<string | null>
}): React.JSX.Element {
  const { project, tasks, filter, collapsed } = props
  const store = useAppStore()
  const visible = tasks.filter((t) => matchesFilter(t, filter))
  const activeCount = tasks.filter((t) => matchesFilter(t, 'active')).length
  const emptyHint =
    tasks.length === 0 ? '该项目暂无任务' : `无${FILTER_LABELS[props.filter]}任务(共 ${tasks.length} 条)`
  return (
    <section className="project-group">
      <h2>
        <button
          className="collapse-toggle"
          aria-expanded={!collapsed}
          title={collapsed ? '展开' : '折叠'}
          onClick={props.onToggleCollapsed}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        {project.name}
        <span className="path">{project.path}</span>
        <span className="count">
          {activeCount} 进行中 / {tasks.length} 总
        </span>
      </h2>
      {!collapsed &&
        (visible.length === 0 ? (
          <p className="project-empty">{emptyHint}</p>
        ) : (
          <div className="task-card">
            {visible.map((task) =>
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
                <TaskRow
                  key={task.id}
                  task={task}
                  onEdit={() => props.setEditingId(task.id)}
                  onOpen={() => props.setDetailId(task.id)}
                  onOpenTask={props.setDetailId}
                />
              )
            )}
          </div>
        ))}
    </section>
  )
}

export function App(): React.JSX.Element {
  const store = useAppStore()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [filter, setFilter] = useState<TaskFilter>('active')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const detailTask = detailId ? (store.tasks.find((t) => t.id === detailId) ?? null) : null
  const sessionTask = sessionId ? (store.tasks.find((t) => t.id === sessionId) ?? null) : null

  const openSessionPanel = (taskId: string): void => {
    setDetailId(null)
    setSessionId(taskId)
  }

  useEffect(() => {
    void store.loadAll()
    void window.dispatchApi
      .invoke('ui-state:get', undefined)
      .then((s) => setCollapsed(new Set(s.collapsedProjectIds)))
      .catch(() => {})
    const offStore = store.subscribe()
    // 系统通知点击等入口要求打开指定任务详情
    const offOpenTask = window.dispatchApi.on('ui:open-task', ({ taskId }) => setDetailId(taskId))
    return () => {
      offStore()
      offOpenTask()
    }
    // 仅挂载时执行一次:store 的方法引用稳定
  }, [])

  const toggleCollapsed = (projectId: string): void => {
    const next = new Set(collapsed)
    if (next.has(projectId)) next.delete(projectId)
    else next.add(projectId)
    setCollapsed(next)
    // 折叠态属界面记忆,持久化失败不影响本次会话,静默即可
    void window.dispatchApi
      .invoke('ui-state:set', { collapsedProjectIds: [...next] })
      .catch(() => {})
  }

  const filterCounts = useMemo(() => {
    const counts = { active: 0, ended: 0, all: store.tasks.length }
    for (const t of store.tasks) counts[matchesFilter(t, 'ended') ? 'ended' : 'active']++
    return counts
  }, [store.tasks])

  const onCreateProject = (): Promise<string | null> =>
    pickAndCreateProject(() => store.refreshProjects())

  return (
    <div className="app">
      {store.hotkey && !store.hotkey.registered && (
        <div className="banner">
          全局快捷键 <code>{store.hotkey.accelerator}</code>{' '}
          注册失败,可能已被其他应用占用。请修改 <code>~/.dispatch/config.json</code> 的{' '}
          <code>hotkey</code> 字段后重启应用(设置页将在后续版本提供)。
        </div>
      )}
      <header className="app-header">
        <h1>Dispatch</h1>
        <span className="sub">任务收件箱 + Agent 调度器</span>
        <span className="spacer" />
        {store.status && (
          <span className="sub">
            v{store.status.version} · {store.status.dispatchHome}
          </span>
        )}
      </header>
      <main className="app-main">
        {store.loadError && <p className="form-error">加载失败:{store.loadError}</p>}
        {store.projects.length === 0 && !store.loadError && (
          <div className="empty">
            <p>还没有项目和任务。</p>
            <p>
              随时按 <code>{store.hotkey?.accelerator ?? '快捷键'}</code> 记一条,
              选好项目、时间与智能体就能到点自动执行。
            </p>
          </div>
        )}
        {store.projects.length > 0 && (
          <div className="filter-chips" role="group" aria-label="任务过滤">
            {TASK_FILTERS.map((f) => (
              <button
                key={f}
                className={`chip${filter === f ? ' active' : ''}`}
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
              >
                {FILTER_LABELS[f]} {filterCounts[f]}
              </button>
            ))}
          </div>
        )}
        {store.projects.map((project) => (
          <ProjectSection
            key={project.id}
            project={project}
            tasks={store.tasks.filter((t) => t.projectId === project.id)}
            filter={filter}
            collapsed={collapsed.has(project.id)}
            onToggleCollapsed={() => toggleCollapsed(project.id)}
            editingId={editingId}
            setEditingId={setEditingId}
            setDetailId={setDetailId}
            onCreateProject={onCreateProject}
          />
        ))}
      </main>
      {detailTask && (
        <TaskDetail
          task={detailTask}
          onClose={() => setDetailId(null)}
          onOpenTask={setDetailId}
          onOpenSession={openSessionPanel}
        />
      )}
      {sessionTask && <SessionPanel task={sessionTask} onClose={() => setSessionId(null)} />}
    </div>
  )
}
