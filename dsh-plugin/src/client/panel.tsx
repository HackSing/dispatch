/**
 * 任务面板:body 级宿主元素 + Shadow DOM 完全隔离(styles.css 含 * / body 全局
 * 规则,直接注入会污染宿主页面;shadow 内注入则内外互不影响)。面板内容 =
 * renderer 的 <App/> 源码级复用;右下角「+」弹 <CaptureApp/> 模态(捕获窗的
 * 面板内形态),capture:hide 经 api-bridge 拦截为关模态。
 *
 * @module dsh-dispatch/client/panel
 */
import React, { StrictMode, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../../src/renderer/src/App'
import { CaptureApp } from '../../../src/renderer/src/CaptureApp'
import stylesCss from '../../../src/renderer/src/styles.css'
import { createApiBridge } from './api-bridge'

/** 与 styles.css 的 body 规则同值(shadow 内 body 规则不命中,需在壳上补齐) */
const SHELL_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.panel-frame {
  position: fixed; inset: 0; z-index: 2147483000;
  display: flex; align-items: stretch; justify-content: stretch;
  font-family: system-ui, -apple-system, 'PingFang SC', sans-serif;
  font-size: 13px; color: #1d1d1f; background: #f5f5f7;
}
button { font: inherit; cursor: pointer; }
.panel-close {
  position: absolute; top: 10px; right: 12px; z-index: 10;
  border: none; background: transparent; font-size: 18px; line-height: 1;
  padding: 4px 8px; border-radius: 6px; color: #6e6e73;
}
.panel-close:hover { background: rgba(0,0,0,0.08); }
.capture-fab {
  position: absolute; right: 18px; bottom: 18px; z-index: 10;
  border: none; border-radius: 999px; padding: 10px 18px; font-size: 14px;
  background: #0071e3; color: #fff; box-shadow: 0 4px 14px rgba(0,0,0,0.25);
}
.capture-modal-layer {
  position: absolute; inset: 0; z-index: 20;
  background: rgba(0,0,0,0.35); display: flex; align-items: flex-start; justify-content: center;
  padding-top: 12vh;
}
`

let panelDisposer: (() => void) | null = null

/** 打开任务面板;已打开时幂等。autoCapture=壳快捷键路径,直接带出捕获模态 */
export function openPanel(options: { autoCapture?: boolean } = {}): void {
  if (panelDisposer) return

  const host = document.createElement('div')
  host.setAttribute('data-dispatch-panel', '')
  document.body.appendChild(host)
  const shadow = host.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = stylesCss + SHELL_CSS
  shadow.appendChild(style)
  const mount = document.createElement('div')
  shadow.appendChild(mount)

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    document.removeEventListener('keydown', onKey)
    root.unmount()
    host.remove()
    panelDisposer = null
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close()
  }
  document.addEventListener('keydown', onKey)

  const bridge = createApiBridge({ onCaptureHide: () => setCaptureVisible(false) })
  ;(window as unknown as { dispatchApi: unknown }).dispatchApi = bridge

  let setCaptureVisible: (v: boolean) => void = () => {}
  const root = createRoot(mount)
  root.render(
    <StrictMode>
      <PanelRoot
        onClose={close}
        initialCapture={options.autoCapture === true}
        onCapture={(setVisible) => {
          setCaptureVisible = setVisible
        }}
      />
    </StrictMode>,
  )
  panelDisposer = close
}

function PanelRoot(props: {
  onClose: () => void
  /** 壳快捷键路径直接带出捕获模态 */
  initialCapture?: boolean
  /** 面板挂载后向外部登记捕获模态的开关(capture:hide 拦截需要关它) */
  onCapture: (setVisible: (v: boolean) => void) => void
}): React.JSX.Element {
  const { onClose, initialCapture, onCapture } = props
  const [captureVisible, setCaptureVisible] = useState(initialCapture === true)
  const frameRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    onCapture(setCaptureVisible)
    frameRef.current?.focus()
  }, [onCapture])
  const toggleCapture = useCallback(() => setCaptureVisible((v) => !v), [])

  return (
    <div className="panel-frame" ref={frameRef} tabIndex={-1}>
      <button className="panel-close" onClick={onClose} title="关闭 (Esc)">
        ×
      </button>
      <div style={{ flex: 1, minHeight: 0 }}>
        <App />
      </div>
      <button className="capture-fab" onClick={toggleCapture}>
        ＋ 快捷新建
      </button>
      {captureVisible ? (
        <div className="capture-modal-layer">
          <CaptureApp />
        </div>
      ) : null}
    </div>
  )
}
