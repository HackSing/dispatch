import { useEffect, useState } from 'react'
import type { Task } from '@shared/types'
import type { TaskStatus } from '@shared/state-machine'
import { useAppStore } from './stores/app-store'
import { TaskEditForm } from './components/TaskEditForm'
import { TaskDetail } from './components/TaskDetail'
import { pickAndCreateProject } from './lib/projects'
import { formatTime } from './lib/time'

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: '待办',
  scheduled: '已排程',
  running: '执行中',
  merging: '合并中',
  awaiting_merge: '待合并',
  conflict: '冲突',
  failed: '失败',
  done: '完成'
}

function triggerLabel(task: Task): string {
  if (task.triggerType === 'immediate') return '触发:立即'
  if (task.triggerType === 'at') return `触发:${formatTime(task.triggerAt)}`
  return ''
}

function TaskRow(props: { task: Task; onEdit: () => void; onOpen: () => void }): React.JSX.Element {
  const { task, onEdit, onOpen } = props
  const [actionError, setActionError] = useState<string | null>(null)
  const editable = task.status === 'todo' || task.status === 'scheduled'

  const run = (fn: () => Promise<unknown>): void => {
    void fn().catch((e: Error) => setActionError(e.message))
  }

  return (
    <div className="task-row">
      <input
        type="checkbox"
        checked={task.status === 'done'}
        disabled={task.status !== 'todo'}
        title={task.status === 'todo' ? '勾选完成' : ''}
        onChange={() => run(() => window.dispatchApi.invoke('task:toggle-todo', { id: task.id }))}
      />
      <div className="task-body" onClick={onOpen} title="查看详情">
        <div className={`task-text${task.status === 'done' ? ' done' : ''}`}>{task.text}</div>
        <div className="task-meta">
          <span className={`badge ${task.status}`}>{STATUS_LABELS[task.status]}</span>
          {triggerLabel(task) && <span>{triggerLabel(task)}</span>}
          {task.agent && <span>{task.agent}</span>}
          <span>创建:{formatTime(task.createdAt)}</span>
          {task.failReason && <span className="form-error">{task.failReason}</span>}
          {actionError && <span className="form-error">{actionError}</span>}
        </div>
      </div>
      <div className="task-actions">
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
      </div>
    </div>
  )
}

export function App(): React.JSX.Element {
  const store = useAppStore()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const detailTask = detailId ? (store.tasks.find((t) => t.id === detailId) ?? null) : null

  useEffect(() => {
    void store.loadAll()
    return store.subscribe()
    // 仅挂载时执行一次:store 的方法引用稳定
  }, [])

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
        {store.tasks.length === 0 && !store.loadError && (
          <div className="empty">
            <p>还没有任务。</p>
            <p>
              随时按 <code>{store.hotkey?.accelerator ?? '快捷键'}</code> 记一条,
              选好时间与智能体就能到点自动执行。
            </p>
          </div>
        )}
        {store.projects.map((project) => {
          const tasks = store.tasks.filter((t) => t.projectId === project.id)
          if (tasks.length === 0) return null
          return (
            <section key={project.id} className="project-group">
              <h2>
                {project.name}
                <span className="path">{project.path}</span>
              </h2>
              <div className="task-card">
                {tasks.map((task) =>
                  editingId === task.id ? (
                    <TaskEditForm
                      key={task.id}
                      task={task}
                      projects={store.projects}
                      detections={store.detections}
                      onCreateProject={onCreateProject}
                      onClose={() => setEditingId(null)}
                    />
                  ) : (
                    <TaskRow
                      key={task.id}
                      task={task}
                      onEdit={() => setEditingId(task.id)}
                      onOpen={() => setDetailId(task.id)}
                    />
                  )
                )}
              </div>
            </section>
          )
        })}
      </main>
      {detailTask && <TaskDetail task={detailTask} onClose={() => setDetailId(null)} />}
    </div>
  )
}
