import { useCallback, useEffect, useState } from 'react'

/**
 * 应用内确认对话框,替代 window.confirm。
 * 背景:本应用渲染进程(Electron sandbox)下原生 window.confirm 点 OK 也同步返回 false
 * (真实复现确认),导致所有以它为闸的危险操作(删除任务/放弃/移除项目)静默无效。
 * 用法:const { ask, confirmNode } = useConfirmDialog();if (await ask(text, { danger: true })) ...
 */

interface ConfirmRequest {
  text: string
  danger: boolean
  resolve: (ok: boolean) => void
}

export function useConfirmDialog(): {
  /** 弹出确认框,用户点「确认」resolve true,取消/Esc/点遮罩 resolve false */
  ask: (text: string, opts?: { danger?: boolean }) => Promise<boolean>
  /** 挂到组件 JSX 末尾;无待确认请求时为 null */
  confirmNode: React.ReactNode
} {
  const [req, setReq] = useState<ConfirmRequest | null>(null)

  const ask = useCallback(
    (text: string, opts?: { danger?: boolean }): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        setReq({ text, danger: opts?.danger ?? false, resolve })
      }),
    []
  )

  // Esc 取消 / Enter 确认,对齐原生 confirm 的键盘行为
  useEffect(() => {
    if (!req) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        req.resolve(false)
        setReq(null)
      } else if (e.key === 'Enter') {
        req.resolve(true)
        setReq(null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [req])

  if (!req) return { ask, confirmNode: null }

  const settle = (ok: boolean): void => {
    req.resolve(ok)
    setReq(null)
  }

  return {
    ask,
    confirmNode: (
      <div
        className="confirm-overlay"
        onClick={(e) => {
          // 阻止冒泡到外层抽屉遮罩(其点击=关闭面板),取消语义只作用于本对话框
          e.stopPropagation()
          settle(false)
        }}
      >
        <div className="confirm-dialog" role="alertdialog" onClick={(e) => e.stopPropagation()}>
          <p className="confirm-text">{req.text}</p>
          <div className="confirm-actions">
            <button className="btn" onClick={() => settle(false)}>
              取消
            </button>
            <button
              className={req.danger ? 'btn danger' : 'btn primary'}
              autoFocus
              onClick={() => settle(true)}
            >
              确认
            </button>
          </div>
        </div>
      </div>
    )
  }
}
