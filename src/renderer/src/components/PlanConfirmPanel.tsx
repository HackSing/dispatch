import { useEffect, useRef, useState } from 'react'
import type { Task } from '@shared/types'
import type { SessionEventPayload } from '@shared/ipc'
import { useAppStore } from '../stores/app-store'

/**
 * 方案确认闸(awaiting_confirm 任务详情内嵌):醒目确认区 + 多轮方案讨论区。
 * 交互布局参照 SessionPanel(日志流 + ⌘/Ctrl+Enter 发送 + 自动滚底 + busy 禁用),
 * 状态纪律遵守 app-store「主进程唯一事实源」:任务状态一律等 task:changed 后重拉,
 * 讨论消息流按 SessionPanel 先例放组件本地 state。
 *
 * 讨论会话生命周期:挂载且有讨论能力时 plan-discuss-open(服务端幂等)。卸载详情页【不关】会话——
 * 会话由主进程按 taskId 持有,进行中的轮次不随详情页开合中断(与追写面板同例:SessionPanel 卸载不关会话,
 * 重开详情即经 discussion.log 回填续上)。会话关闭只发生在:确认放行 / 放弃 / 应用退出 / 轮级失败自关。
 * 能力缺失(store followUp 为假或 open 失败)吞为「无讨论能力」UI 态,只保留查看方案 + 确认。
 */
export function PlanConfirmPanel(props: {
  task: Task
  /** 讨论轮次结束(可能已修订 plan.md)时通知 TaskDetail 重拉归档刷新方案展示 */
  onPlanRevised?: () => void
}): React.JSX.Element {
  const { task, onPlanRevised } = props
  const capabilities = useAppStore((s) => s.capabilities)
  const capability = task.agent ? capabilities?.[task.agent] : undefined
  const discussCapable = capability?.followUp === true

  const [log, setLog] = useState('')
  const [busy, setBusy] = useState(false)
  const [closedReason, setClosedReason] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  /** open 失败(如服务端判定该 agent 无讨论能力):降级为无讨论态,不弹错误 */
  const [discussUnavailable, setDiscussUnavailable] = useState(false)
  const logRef = useRef<HTMLPreElement | null>(null)

  const canDiscuss = discussCapable && !discussUnavailable
  const active = closedReason === null

  // 讨论历史回填一次:重开详情/中途进入时从归档 discussion.log 恢复上下文(SessionPanel 先例)
  useEffect(() => {
    if (!discussCapable) return
    window.dispatchApi
      .invoke('task:archive', { id: task.id })
      .then((a) => setLog(a.discussionLog ?? ''))
      .catch(() => {
        /* 回填失败不阻断确认;实时事件仍会补流 */
      })
  }, [task.id, discussCapable])

  // 讨论会话随挂载开启(服务端幂等);卸载【不关】——见文件头注释,进行中的轮次不随详情页开合中断
  // open 返回服务端 busy:重开详情时若轮次仍在跑,恢复输入闸门(busy 是本地 state,不落任务状态)
  useEffect(() => {
    if (task.status !== 'awaiting_confirm' || !discussCapable) return
    window.dispatchApi
      .invoke('task:plan-discuss-open', { id: task.id })
      .then((s) => {
        if (s?.busy) setBusy(true)
      })
      .catch(() => setDiscussUnavailable(true))
  }, [task.id, task.status, discussCapable])

  // 实时增量:round-start 置 busy、chunk 追加、round-result 追加轮次结束行并刷新方案、closed 锁定输入
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
        onPlanRevised?.()
      } else if (payload.kind === 'closed') {
        setBusy(false)
        setClosedReason(payload.reason ?? 'failed')
      }
    })
    return off
  }, [task.id, onPlanRevised])

  // 新内容自动滚底
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log])

  const send = (): void => {
    const text = input.trim()
    if (!text) return
    setError(null)
    window.dispatchApi
      .invoke('task:plan-discuss-send', { id: task.id, text })
      .then(() => {
        setInput('')
        setLog((prev) => prev + `\n[user] ${text}\n`)
      })
      .catch((e: Error) => setError(e.message))
  }

  // 确认成功后不本地改状态:主进程 task:changed 会驱动 store 重拉,任务离开 awaiting_confirm
  // 本组件随之卸载(cleanup 关讨论会话)。失败才复位 confirming 允许重试。
  const confirm = (): void => {
    setConfirming(true)
    setError(null)
    window.dispatchApi.invoke('task:confirm-plan', { id: task.id }).catch((e: Error) => {
      setError(e.message)
      setConfirming(false)
    })
  }

  return (
    <>
      <section className="detail-section">
        <h3>方案确认</h3>
        <div className="scard plan-confirm-card">
          <p>方案已完成,确认后才开始执行。可先在下方与主智能体讨论修订,或直接放行。</p>
          <button className="btn primary" disabled={confirming} onClick={confirm}>
            {confirming ? '正在放行…' : '确认,开始执行'}
          </button>
          {error && <p className="form-error">{error}</p>}
        </div>
      </section>

      <section className="detail-section">
        <h3>方案讨论</h3>
        {canDiscuss ? (
          <>
            <pre ref={logRef} className="detail-pre log-box" role="log" aria-live="polite">
              {log || '与主智能体讨论以修订方案,或直接确认执行。'}
            </pre>
            {closedReason && (
              <p className="session-closed">讨论会话已结束,可重开详情继续,或直接确认 / 放弃。</p>
            )}
            <div className="session-input plan-discuss-input">
              <label className="sr-only" htmlFor="plan-discuss-text">
                方案讨论内容
              </label>
              <textarea
                id="plan-discuss-text"
                value={input}
                placeholder={busy ? '本轮进行中…' : '输入修订意见,⌘ + Enter 发送'}
                disabled={!active || busy}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send()
                }}
              />
              <div className="session-actions">
                <span className="spacer" />
                <button
                  className="btn primary"
                  disabled={!active || busy || !input.trim()}
                  onClick={send}
                >
                  发送
                </button>
              </div>
            </div>
          </>
        ) : (
          <p className="detail-notes">该智能体不支持会话讨论,可直接确认或放弃。</p>
        )}
      </section>
    </>
  )
}
