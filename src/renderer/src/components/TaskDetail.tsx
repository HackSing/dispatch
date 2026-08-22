import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Task } from '@shared/types'
import type { TaskArchive } from '@shared/ipc'
import type { TaskResult } from '@core/agents/types'
import { useAppStore } from '../stores/app-store'
import { agentChainLabel, phaseDetailLabel, statusBadgeLabel } from '../lib/task-labels'
import { formatElapsed, formatTime } from '../lib/time'
import { TaskOps, ToggleTodoButton } from './TaskOps'

const ACTIVE_POLL_MS = 3000

/** 归档中的审查报告文件(review-r1.md / review-r2.json …),TaskArchive 契约不含内容,只能按文件名探测 */
const REVIEW_FILE_RE = /^review-r(\d+)\.(md|json)$/

function countReviewRounds(files: { name: string }[]): number {
  const rounds = new Set<number>()
  for (const f of files) {
    const m = REVIEW_FILE_RE.exec(f.name)
    if (m) rounds.add(Number(m[1]))
  }
  return rounds.size
}

function isActive(task: Task): boolean {
  return task.status === 'running' || task.status === 'merging'
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function parseResult(raw: string | null): TaskResult | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as TaskResult
  } catch {
    return null
  }
}

function Section(props: {
  title: string
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className={`detail-section${props.className ? ` ${props.className}` : ''}`}>
      <h3>{props.title}</h3>
      {props.children}
    </section>
  )
}

/** 会话入口区:继续对话(开面板)/ 打开会话面板(重入)/ 在终端打开会话(逃生舱) */
function SessionEntry(props: {
  task: Task
  onOpenSession?: (taskId: string) => void
}): React.JSX.Element | null {
  const { task, onOpenSession } = props
  const capabilities = useAppStore((s) => s.capabilities)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const capability = task.agent ? capabilities?.[task.agent] : undefined
  const settled = task.status === 'done' || task.status === 'failed'
  const canFollowUp = settled && task.sessionId !== null && capability?.followUp === true
  const canTerminal = task.sessionId !== null && capability?.terminal === true
  // 接力任务执行中(面板会话进行中)允许重新打开面板视图
  const canReattach = task.status === 'running' && task.parentTaskId !== null

  if (!canFollowUp && !canTerminal && !canReattach) return null

  const run = (fn: () => Promise<void>): void => {
    setBusy(true)
    setError(null)
    void fn()
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }

  const startFollowUp = (): void =>
    run(async () => {
      const follow = await window.dispatchApi.invoke('task:follow-up-start', { parentId: task.id })
      onOpenSession?.(follow.id)
    })

  const openTerminal = (): void =>
    run(() => window.dispatchApi.invoke('task:open-session-terminal', { id: task.id }))

  return (
    <div className="detail-actions session-entry">
      {canFollowUp && (
        <button
          className="btn primary"
          disabled={busy}
          title="在原会话上继续多轮对话(新工作区,结束时一次合并)"
          onClick={startFollowUp}
        >
          继续对话
        </button>
      )}
      {canReattach && (
        <button
          className="btn primary"
          disabled={busy}
          title="回到进行中的会话面板"
          onClick={() => onOpenSession?.(task.id)}
        >
          打开会话面板
        </button>
      )}
      {canTerminal && (
        <button
          className="btn"
          disabled={busy}
          title="在系统终端里交互式续接该会话(改动不经 Dispatch 管线)"
          onClick={openTerminal}
        >
          在终端打开会话
        </button>
      )}
      {error && <span className="form-error">{error}</span>}
    </div>
  )
}

/** 接力链:父任务与由本任务派生的接力任务互相跳转 */
function SessionChain(props: {
  task: Task
  onOpenTask?: (taskId: string) => void
}): React.JSX.Element | null {
  const { task, onOpenTask } = props
  const tasks = useAppStore((s) => s.tasks)
  const parent = task.parentTaskId ? tasks.find((t) => t.id === task.parentTaskId) : undefined
  const children = tasks.filter((t) => t.parentTaskId === task.id)
  if (!parent && children.length === 0) return null
  return (
    <Section title="会话链">
      <ul className="detail-files">
        {parent && (
          <li>
            接力自:
            <button className="btn link" onClick={() => onOpenTask?.(parent.id)}>
              {parent.text.split('\n')[0]}
            </button>
          </li>
        )}
        {children.map((c) => (
          <li key={c.id}>
            接力会话:
            <button className="btn link" onClick={() => onOpenTask?.(c.id)}>
              {c.text}
            </button>
            <span className={`badge ${c.status}`}>{statusBadgeLabel(c)}</span>
          </li>
        ))}
      </ul>
    </Section>
  )
}

export function TaskDetail(props: {
  task: Task
  onClose: () => void
  onOpenTask?: (taskId: string) => void
  onOpenSession?: (taskId: string) => void
}): React.JSX.Element {
  const { task, onClose, onOpenTask } = props
  const [archive, setArchive] = useState<TaskArchive | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 状态变化即重拉;执行/合并中每 3s 轮询,日志与产物随进度出现
  useEffect(() => {
    const fetchArchive = (): void => {
      window.dispatchApi
        .invoke('task:archive', { id: task.id })
        .then(setArchive)
        .catch((e: Error) => setError(e.message))
    }
    fetchArchive()
    if (!isActive(task)) return
    const timer = setInterval(fetchArchive, ACTIVE_POLL_MS)
    return () => clearInterval(timer)
  }, [task.id, task.status])

  // 执行中的耗时每秒跳动
  const [nowMs, setNowMs] = useState(Date.now())
  useEffect(() => {
    if (!isActive(task)) return
    const timer = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [task.id, task.status])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const result = parseResult(archive?.resultRaw ?? null)
  const reviewRounds = countReviewRounds(archive?.files ?? [])
  const openArchive = (): void => {
    void window.dispatchApi.invoke('task:open-archive', { id: task.id })
  }

  return (
    <div className="detail-overlay" onClick={onClose}>
      <div className="detail-panel" onClick={(e) => e.stopPropagation()}>
        <header className="detail-header">
          <span className={`badge ${task.status}`}>{statusBadgeLabel(task)}</span>
          <span className="detail-title">{task.text.split('\n')[0]}</span>
          <span className="spacer" />
          {task.archiveDir && (
            <button className="btn" title="在 Finder 中打开归档目录" onClick={openArchive}>
              打开归档
            </button>
          )}
          <button className="btn" onClick={onClose}>
            关闭 Esc
          </button>
        </header>

        {(task.status === 'failed' ||
          task.status === 'conflict' ||
          task.status === 'awaiting_merge') && (
          <div className="detail-actions">
            <TaskOps task={task} onOpenTask={onOpenTask} />
          </div>
        )}

        {(task.status === 'todo' || task.status === 'done') && (
          <div className="detail-actions">
            <ToggleTodoButton task={task} verbose />
          </div>
        )}

        <SessionEntry task={task} onOpenSession={props.onOpenSession} />

        <div className="detail-body">
          {task.status === 'conflict' && task.worktreePath && (
            <div className="conflict-callout">
              <p>合并冲突:请在下方 worktree 内手动解决后点「已解决,重试合并」,或放弃该任务。</p>
              <code>{task.worktreePath}</code>
            </div>
          )}

          <Section title="任务原文">
            <pre className="detail-pre">{task.text}</pre>
          </Section>

          <Section title="元数据">
            <div className="detail-meta">
              {task.agent && <span>智能体:{agentChainLabel(task)}</span>}
              {phaseDetailLabel(task) && <span>当前阶段:{phaseDetailLabel(task)}</span>}
              <span>创建:{formatTime(task.createdAt)}</span>
              {task.startedAt && <span>开始:{formatTime(task.startedAt)}</span>}
              {isActive(task) && task.startedAt && (
                <span>已执行:{formatElapsed(task.startedAt, nowMs)}</span>
              )}
              {task.finishedAt && <span>结束:{formatTime(task.finishedAt)}</span>}
              {task.baseBranch && <span>基线:{task.baseBranch}</span>}
              {task.branch && (
                <span>
                  分支:{task.branch}
                  {/* 分支名是历史记录;终态且 worktree 已清即分支已删 */}
                  {!task.worktreePath && (task.status === 'done' || task.status === 'failed')
                    ? '(已删除)'
                    : ''}
                </span>
              )}
              {task.worktreePath && <span>worktree:{task.worktreePath}</span>}
              {task.failReason && <span className="form-error">失败原因:{task.failReason}</span>}
            </div>
          </Section>

          <SessionChain task={task} onOpenTask={onOpenTask} />

          {error && <p className="form-error">归档读取失败:{error}</p>}

          {reviewRounds > 0 && (
            <Section title="审查结论" className="review-summary">
              <p className="detail-summary">
                本任务经 {reviewRounds} 轮审查,审查报告(review-r*.md)见归档目录。
              </p>
              {task.archiveDir && (
                <button className="btn" title="在 Finder 中打开归档目录" onClick={openArchive}>
                  打开归档
                </button>
              )}
            </Section>
          )}

          {result && (
            <Section title={`结果 · ${result.status}`}>
              <p className="detail-summary">{result.summary}</p>
              {result.files_changed && result.files_changed.length > 0 && (
                <ul className="detail-files">
                  {result.files_changed.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              )}
              {result.notes && <p className="detail-notes">备注:{result.notes}</p>}
              {result.follow_up && <p className="detail-notes">后续建议:{result.follow_up}</p>}
            </Section>
          )}
          {!result && archive?.resultRaw && (
            <Section title="结果(原始,解析失败)">
              <pre className="detail-pre">{archive.resultRaw}</pre>
            </Section>
          )}

          {archive?.conflictReport && (
            <Section
              title="冲突报告"
              className={task.status === 'conflict' ? 'conflict-highlight' : undefined}
            >
              <div className="markdown">
                <ReactMarkdown>{archive.conflictReport}</ReactMarkdown>
              </div>
            </Section>
          )}

          {archive?.planMd && (
            <Section title="方案 plan.md">
              <div className="markdown">
                <ReactMarkdown>{archive.planMd}</ReactMarkdown>
              </div>
            </Section>
          )}

          {archive?.logTail && (
            <Section title={isActive(task) ? '执行日志(实时)' : '执行日志(尾部)'}>
              <pre className="detail-pre log-box">{archive.logTail}</pre>
            </Section>
          )}

          {archive && archive.files.length > 0 && (
            <Section title="归档文件">
              <ul className="detail-files">
                {archive.files.map((f) => (
                  <li key={f.name}>
                    {f.name} <span className="detail-notes">({formatSize(f.size)})</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      </div>
    </div>
  )
}
