/**
 * 任务面板:body 级宿主元素 + Shadow DOM 完全隔离(styles.css 含 * / body 全局
 * 规则,直接注入会污染宿主页面;shadow 内注入则内外互不影响)。面板内容 =
 * renderer 的 <App/> 源码级复用;右下角「+」弹 <CaptureApp/> 模态(捕获窗的
 * 面板内形态),capture:hide 经 api-bridge 拦截为关模态。
 *
 * 模态形态:CaptureApp 按独立捕获整窗设计(100vh + 窗口拖拽区),模态卡片容器
 * 负责收编——限宽居中、textarea 定高、拖拽区还原为普通标题行。Esc 分层:模态
 * 开着时 CaptureApp 自己收 Esc(capture:hide→关模态),面板的 Esc 只在模态
 * 关着时关整个面板。
 *
 * @module dsh-dispatch/client/panel
 */
import React, { StrictMode, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../../src/renderer/src/App'
import { CaptureApp } from '../../../src/renderer/src/CaptureApp'
// 渲染层样式按界面层拆分(主窗 styles+drawers,捕获窗 styles+capture);
// 面板同时承载两者,三份全量注入 shadow
import stylesCss from '../../../src/renderer/src/styles.css'
import drawersCss from '../../../src/renderer/src/drawers.css'
import captureCss from '../../../src/renderer/src/capture.css'
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
  background: rgba(0, 0, 0, 0.4);
  display: flex; align-items: center; justify-content: center;
  padding: 32px;
}
.capture-modal-card {
  position: relative;
  width: min(640px, 100%);
  border-radius: 16px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.35);
}
.capture-modal-card .capture {
  height: auto;
  background: #f8f8fa;
}
.capture-modal-card .capture textarea {
  flex: none;
  height: 150px;
}
.capture-modal-card .capture-drag {
  -webkit-app-region: no-drag;
  padding-top: 12px;
  padding-right: 34px;
}
.capture-modal-close {
  position: absolute; top: 7px; right: 9px; z-index: 5;
  display: flex; align-items: center; justify-content: center;
  width: 24px; height: 24px;
  border: none; border-radius: 6px; background: transparent;
  font-size: 15px; line-height: 1; color: #a1a1a6;
}
.capture-modal-close:hover { background: rgba(0,0,0,0.08); color: #1d1d1f; }
`

let panelDisposer: (() => void) | null = null
/** 已开面板的捕获模态开关(快捷键再次触发时补出模态用) */
let captureController: { setVisible(v: boolean): void } | null = null

// 面板开合状态:侧栏入口的 active 高亮数据源
const panelOpenListeners = new Set<() => void>()
let panelOpen = false

export function subscribePanelOpen(listener: () => void): () => void {
  panelOpenListeners.add(listener)
  return () => {
    panelOpenListeners.delete(listener)
  }
}

export function isPanelOpen(): boolean {
  return panelOpen
}

function setPanelOpen(open: boolean): void {
  panelOpen = open
  for (const listener of panelOpenListeners) listener()
}

/** 打开任务面板;已打开时幂等(autoCapture 时仅补出捕获模态) */
export function openPanel(options: { autoCapture?: boolean } = {}): void {
  if (panelDisposer) {
    if (options.autoCapture) captureController?.setVisible(true)
    return
  }

  const host = document.createElement('div')
  host.setAttribute('data-dispatch-panel', '')
  document.body.appendChild(host)
  const shadow = host.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = stylesCss + drawersCss + captureCss + SHELL_CSS
  shadow.appendChild(style)
  const mount = document.createElement('div')
  shadow.appendChild(mount)

  let closed = false
  // 模态开合的镜像(供 document 级 Esc 判层,不进 React)
  let captureOpen = options.autoCapture === true
  const close = () => {
    if (closed) return
    closed = true
    document.removeEventListener('keydown', onKey)
    setPanelOpen(false)
    captureController = null
    root.unmount()
    host.remove()
    panelDisposer = null
  }
  // Esc 分层:模态开着时交给 CaptureApp(其自身 Esc→capture:hide→关模态),
  // 模态关着才关整个面板
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !captureOpen) close()
  }
  document.addEventListener('keydown', onKey)

  const bridge = createApiBridge({ onCaptureHide: () => captureController?.setVisible(false) })
  ;(window as unknown as { dispatchApi: unknown }).dispatchApi = bridge

  const root = createRoot(mount)
  root.render(
    <StrictMode>
      <PanelRoot
        onClose={close}
        initialCapture={captureOpen}
        onCaptureRegister={(setVisible) => {
          captureController = { setVisible }
        }}
        onCaptureSync={(open) => {
          captureOpen = open
        }}
      />
    </StrictMode>,
  )
  setPanelOpen(true)
  panelDisposer = close
}

function PanelRoot(props: {
  onClose: () => void
  /** 壳快捷键路径直接带出捕获模态 */
  initialCapture?: boolean
  /** 挂载后登记捕获模态开关(capture:hide 拦截与快捷键补出需要) */
  onCaptureRegister: (setVisible: (v: boolean) => void) => void
  /** 模态开合同步给外层 Esc 判层 */
  onCaptureSync: (open: boolean) => void
}): React.JSX.Element {
  const { onClose, initialCapture, onCaptureRegister, onCaptureSync } = props
  const [captureVisible, setCaptureVisible] = useState(initialCapture === true)
  const frameRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    onCaptureRegister(setCaptureVisible)
    frameRef.current?.focus()
  }, [onCaptureRegister])
  useEffect(() => {
    onCaptureSync(captureVisible)
    if (!captureVisible) frameRef.current?.focus()
  }, [onCaptureSync, captureVisible])
  const toggleCapture = useCallback(() => setCaptureVisible((v) => !v), [])
  // 点遮罩收起;从卡片内拖选文本落在遮罩上的 click 不算(有选区时忽略)
  const onBackdropClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    if (window.getSelection()?.toString()) return
    setCaptureVisible(false)
  }, [])

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
        <div className="capture-modal-layer" onClick={onBackdropClick}>
          <div className="capture-modal-card" onClick={(e) => e.stopPropagation()}>
            <button
              className="capture-modal-close"
              onClick={() => setCaptureVisible(false)}
              title="收起 (Esc)"
            >
              ×
            </button>
            <CaptureApp />
          </div>
        </div>
      ) : null}
    </div>
  )
}
