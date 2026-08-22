import { useEffect, useRef, useState } from 'react'
import type { Task } from '@shared/types'
import type { SessionEventPayload } from '@shared/ipc'
import { statusBadgeLabel } from '../lib/task-labels'
import { DotsIcon } from './icons'
import { usePopoverDismiss } from '../lib/use-popover'

/** 会话级操作(完成并合并 / 放弃)收敛在头部 ⋯ 菜单,输入区只留发送(交互定稿) */
function SessionMenu(props: {
  disabled: boolean
  onFinish: () => void
  onAbandon: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 })
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)

  usePopoverDismiss(open, wrapRef, () => setOpen(false))

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

  const select = (fn: () => void): void => {
    setOpen(false)
    fn()
  }

  return (
    <div className="menu-wrap" ref={wrapRef}>
      <button
        ref={btnRef}
        className="menu-btn"
        disabled={props.disabled}
        title="会话操作"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggleOpen}
      >
        <DotsIcon />
      </button>
      {open && (
        <div className="menu-pop" role="menu" style={pos}>
          <button
            role="menuitem"
            className="menu-item"
            title="关闭会话并走合并链路"
            onClick={() => select(props.onFinish)}
          >
            完成,合并
          </button>
          <div className="menu-sep" />
          <button
            role="menuitem"
            className="menu-item danger"
            title="标记失败并清理 worktree"
            onClick={() => select(props.onAbandon)}
          >
            放弃
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * 面板会话视图:轮次时间线(v1 = 过滤后文本流)+ 输入区(发送右置)。
 * 历史回填取归档 output.log 尾部,实时增量订阅 task:session-event;
 * 会话生死以 closed 事件与任务状态为准(主进程唯一事实源)。
 */
export function SessionPanel(props: { task: Task; onClose: () => void }): React.JSX.Element {
  const { task, onClose } = props
  const [log, setLog] = useState('')
  const [busy, setBusy] = useState(false)
  const [closedReason, setClosedReason] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const logRef = useRef<HTMLPreElement | null>(null)

  const active = task.status === 'running' && closedReason === null

  // 历史回填一次:重开面板/中途进入时从归档日志恢复上下文
  useEffect(() => {
    window.dispatchApi
      .invoke('task:archive', { id: task.id })
      .then((a) => setLog(a.logTail ?? ''))
      .catch((e: Error) => setError(e.message))
  }, [task.id])

  useEffect(() => {
    const off = window.dispatchApi.on('task:session-event', (payload: SessionEventPayload) => {
      if (payload.taskId !== task.id) return
      if (payload.kind === 'chunk' && payload.text) {
        setLog((prev) => prev + payload.text)
      } else if (payload.kind === 'round-start') {
        setBusy(true)
      } else if (payload.kind === 'round-result' && payload.result) {
        setBusy(false)
        const r = payload.result
        const cost = r.costUsd !== null ? ` · $${r.costUsd.toFixed(4)}` : ''
        setLog(
          (prev) =>
            prev +
            `— 第 ${payload.round} 轮结束 · ${(r.durationMs / 1000).toFixed(1)}s${cost}` +
            `${r.isError ? ' · 本轮出错' : ''} —\n`
        )
      } else if (payload.kind === 'closed') {
        setBusy(false)
        setClosedReason(payload.reason ?? 'failed')
      }
    })
    return off
  }, [task.id])

  // 新内容自动滚底
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const send = (): void => {
    const text = input.trim()
    if (!text) return
    setError(null)
    window.dispatchApi
      .invoke('task:follow-up-send', { id: task.id, text })
      .then(() => {
        setInput('')
        setLog((prev) => prev + `\n[user] ${text}\n`)
      })
      .catch((e: Error) => setError(e.message))
  }

  const finish = (): void => {
    if (!window.confirm('完成本次会话并合并改动?')) return
    setError(null)
    window.dispatchApi
      .invoke('task:follow-up-finish', { id: task.id })
      .then(() => onClose())
      .catch((e: Error) => setError(e.message))
  }

  const abandon = (): void => {
    if (!window.confirm('放弃本次会话?将标记为失败,并删除其 worktree 与任务分支(归档保留)。'))
      return
    setError(null)
    window.dispatchApi
      .invoke('task:follow-up-abandon', { id: task.id })
      .then(() => onClose())
      .catch((e: Error) => setError(e.message))
  }

  const closedLabel: Record<string, string> = {
    finished: '会话已完成,合并进行中(详情页可见进展)',
    abandoned: '会话已放弃',
    failed: '会话已终止(详情页可见失败原因)'
  }

  return (
    <div className="detail-overlay" onClick={onClose}>
      <div className="detail-panel session-panel" onClick={(e) => e.stopPropagation()}>
        <header className="detail-header">
          <span className={`badge ${task.status}`}>{statusBadgeLabel(task)}</span>
          {task.parentTaskId && <span className="badge relay">接力</span>}
          <span className="detail-title">{task.text}</span>
          <span className="spacer" />
          <SessionMenu disabled={!active || busy} onFinish={finish} onAbandon={abandon} />
          <button className="btn" onClick={onClose} title="收起面板,会话继续保留">
            收起 <span className="key">esc</span>
          </button>
        </header>

        <pre ref={logRef} className="session-log" role="log" aria-live="polite">
          {log || '会话已就绪,输入第一轮内容开始。'}
        </pre>

        {closedReason && <p className="session-closed">{closedLabel[closedReason] ?? closedReason}</p>}
        {error && <p className="form-error">{error}</p>}

        <div className="session-input">
          <label className="sr-only" htmlFor="session-input-text">
            追问内容
          </label>
          <textarea
            id="session-input-text"
            value={input}
            placeholder={busy ? '本轮进行中…' : '输入追问内容,⌘ + Enter 发送'}
            disabled={!active || busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send()
            }}
          />
          <div className="session-actions">
            <span className="spacer" />
            <button className="btn primary" disabled={!active || busy || !input.trim()} onClick={send}>
              发送
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
