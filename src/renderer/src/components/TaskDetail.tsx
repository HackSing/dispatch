import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Task } from '@shared/types'
import type { TaskArchive } from '@shared/ipc'
import type { TaskResult } from '@core/agents/types'
import { formatElapsed, formatTime } from '../lib/time'

const ACTIVE_POLL_MS = 3000

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

function Section(props: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="detail-section">
      <h3>{props.title}</h3>
      {props.children}
    </section>
  )
}

export function TaskDetail(props: { task: Task; onClose: () => void }): React.JSX.Element {
  const { task, onClose } = props
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

  return (
    <div className="detail-overlay" onClick={onClose}>
      <div className="detail-panel" onClick={(e) => e.stopPropagation()}>
        <header className="detail-header">
          <span className={`badge ${task.status}`}>{task.status}</span>
          <span className="detail-title">{task.text.split('\n')[0]}</span>
          <span className="spacer" />
          {task.archiveDir && (
            <button
              className="btn"
              title="在 Finder 中打开归档目录"
              onClick={() => void window.dispatchApi.invoke('task:open-archive', { id: task.id })}
            >
              打开归档
            </button>
          )}
          <button className="btn" onClick={onClose}>
            关闭 Esc
          </button>
        </header>

        <div className="detail-body">
          <Section title="任务原文">
            <pre className="detail-pre">{task.text}</pre>
          </Section>

          <Section title="元数据">
            <div className="detail-meta">
              {task.agent && <span>智能体:{task.agent}</span>}
              <span>创建:{formatTime(task.createdAt)}</span>
              {task.startedAt && <span>开始:{formatTime(task.startedAt)}</span>}
              {isActive(task) && task.startedAt && (
                <span>已执行:{formatElapsed(task.startedAt, nowMs)}</span>
              )}
              {task.finishedAt && <span>结束:{formatTime(task.finishedAt)}</span>}
              {task.baseBranch && <span>基线:{task.baseBranch}</span>}
              {task.branch && <span>分支:{task.branch}</span>}
              {task.worktreePath && <span>worktree:{task.worktreePath}</span>}
              {task.failReason && <span className="form-error">失败原因:{task.failReason}</span>}
            </div>
          </Section>

          {error && <p className="form-error">归档读取失败:{error}</p>}

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
            <Section title="冲突报告">
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
