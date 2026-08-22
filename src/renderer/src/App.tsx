import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from './stores/app-store'
import { TaskDetail } from './components/TaskDetail'
import { SessionPanel } from './components/SessionPanel'
import { ProjectColumn } from './components/ProjectColumn'
import { PlusIcon } from './components/icons'
import { pickAndCreateProject } from './lib/projects'
import { FILTER_LABELS, matchesFilter, TASK_FILTERS, type TaskFilter } from './lib/task-filters'

/** 主窗:项目列看板(方向 B 定稿)。过滤分段控件与新建项目按钮同行,列区横向滚动。 */
export function App(): React.JSX.Element {
  const store = useAppStore()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [filter, setFilter] = useState<TaskFilter>('active')
  const detailTask = detailId ? (store.tasks.find((t) => t.id === detailId) ?? null) : null
  const sessionTask = sessionId ? (store.tasks.find((t) => t.id === sessionId) ?? null) : null

  const openSessionPanel = (taskId: string): void => {
    setDetailId(null)
    setSessionId(taskId)
  }

  useEffect(() => {
    void store.loadAll()
    const offStore = store.subscribe()
    // 系统通知点击等入口要求打开指定任务详情
    const offOpenTask = window.dispatchApi.on('ui:open-task', ({ taskId }) => setDetailId(taskId))
    return () => {
      offStore()
      offOpenTask()
    }
    // 仅挂载时执行一次:store 的方法引用稳定
  }, [])

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
          全局快捷键 <code>{store.hotkey.accelerator}</code> 注册失败,可能已被其他应用占用。
          {store.hotkey.hint ?? (
            <>
              请修改 <code>~/.dispatch/config.json</code> 的 <code>hotkey</code>{' '}
              字段后重启应用(设置页将在后续版本提供)。
            </>
          )}
        </div>
      )}
      <header className="app-header">
        <h1>Dispatch</h1>
        <span className="sub">任务收件箱 + Agent 调度器</span>
        <span className="spacer" />
        {store.status && (
          <span className="meta">
            v{store.status.version} · {store.status.dispatchHome}
          </span>
        )}
      </header>
      {store.loadError && <p className="form-error" role="alert">加载失败:{store.loadError}</p>}
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
        <>
          <div className="toolbar-row">
            <div className="seg" role="group" aria-label="任务过滤">
              {TASK_FILTERS.map((f) => (
                <button
                  key={f}
                  className={filter === f ? 'on' : ''}
                  aria-pressed={filter === f}
                  onClick={() => setFilter(f)}
                >
                  {FILTER_LABELS[f]} {filterCounts[f]}
                </button>
              ))}
            </div>
            <span className="spacer" />
            <button className="btn" onClick={() => void onCreateProject()}>
              <PlusIcon /> 新建项目
            </button>
          </div>
          <main className="app-main">
            <div className="board">
              {store.projects.map((project) => (
                <ProjectColumn
                  key={project.id}
                  project={project}
                  tasks={store.tasks.filter((t) => t.projectId === project.id)}
                  filter={filter}
                  editingId={editingId}
                  setEditingId={setEditingId}
                  setDetailId={setDetailId}
                  onOpenSession={openSessionPanel}
                  onCreateProject={onCreateProject}
                />
              ))}
            </div>
          </main>
        </>
      )}
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
