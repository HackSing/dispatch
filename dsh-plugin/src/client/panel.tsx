/**
 * 任务视图:task-board 同款中列接管(board-mount 先例)。视图容器作为
 * centerCol 的追加子元素铺满中列(position:absolute inset:0),React 树只在
 * apply 时挂一次,开合只切 <html data-dispatch-panel-active> 属性——中列下的
 * 对话子树保持挂载与状态,CSS 隐藏而非卸载。
 *
 * 让位协议(与 task-board/ssh 互操作):打开时移除兄弟面板的 active 属性并
 * 广播 dsh-panel-activate;收到其它面板名的事件时自行关闭;点侧栏会话/工作
 * 区/新会话行时把中列还给对话(capture 相位,先于壳处理)。
 *
 * 视图内部仍是 Shadow DOM 完全隔离(styles.css 含 * / body 全局规则);
 * 右下角「+」弹 <CaptureApp/> 模态(限宽居中卡片),capture:hide 经
 * api-bridge 拦截为关模态;Esc 只关模态(视图不绑 Esc,与 task-board 一致)。
 *
 * @module dsh-dispatch/client/panel
 */
import React, { StrictMode, useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../../src/renderer/src/App'
import { CaptureApp } from '../../../src/renderer/src/CaptureApp'
// 渲染层样式按界面层拆分(主窗 styles+drawers,捕获窗 styles+capture);
// 面板同时承载两者,三份全量注入 shadow
import stylesCss from '../../../src/renderer/src/styles.css'
import drawersCss from '../../../src/renderer/src/drawers.css'
import captureCss from '../../../src/renderer/src/capture.css'
import { createApiBridge } from './api-bridge'

const VIEW_ATTR = 'data-dispatch-panel-view'
const ACTIVE_ATTR = 'data-dispatch-panel-active'
const STYLE_ID = 'dsh-dispatch-panel-view-style'
const COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"]'
/** 兄弟面板的激活属性:打开时移除,让中列单占有人立即让位 */
const OTHER_ACTIVE_ATTRS = ['data-dsh-taskboard-active', 'data-dsh-ssh-active']
/** 跨插件激活事件(task-board 约定):detail 为激活面板名 */
const ACTIVATE_EVENT = 'dsh-panel-activate'
const PANEL_NAME = 'dispatch'
/** 点这些侧栏行 = 把中列还给对话(task-board 同款选择器) */
const SIDEBAR_ROW_SELECTOR =
  '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]'

/** 视图容器与兄弟隐藏规则(light DOM,全部锚定属性选择器,主题令牌兜底遮底) */
const VIEW_CSS = `
[data-pane='conversation'],
[class*='centerCol'] {
  position: relative;
}
[data-dispatch-panel-view] {
  position: absolute;
  inset: 0;
  display: none;
  z-index: 60;
  background: var(--dsw-alias-bg-base);
}
html[data-dispatch-panel-active] [data-dispatch-panel-view] {
  display: block;
}
/* 激活时隐藏中列下的对话内容(保持挂载与状态);!important 压过壳的
   inline display:contents 包裹(task-board issue #76 先例) */
html[data-dispatch-panel-active] [data-pane='conversation'] > :not([data-dispatch-panel-view]),
html[data-dispatch-panel-active] [class*='centerCol'] > :not([data-dispatch-panel-view]) {
  display: none !important;
}
`

/** shadow 内部骨架:视图根(铺满容器,relative 锚定 FAB/模态)+ 模态卡片 */
const SHELL_CSS = `
* { box-sizing: border-box; }
.panel-mount {
  width: 100%;
  height: 100%;
}
.panel-frame {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: stretch;
  justify-content: stretch;
  font-family: system-ui, -apple-system, 'PingFang SC', sans-serif;
  font-size: 13px;
  color: #1d1d1f;
  background: #f5f5f7;
}
button { font: inherit; cursor: pointer; }
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
/* 捕获窗按独立整窗设计(100vh + 拖拽区),模态形态由卡片容器收编:
   限宽居中、textarea 定高、拖拽区还原为普通标题行 */
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

// ---- 开合状态(纯 DOM 同步切换,不进 React——与 task-board controller 同语义) ----

const panelOpenListeners = new Set<() => void>()
let panelOpen = false
/** 已挂视图的捕获模态开关(关视图时顺手收起模态;快捷键路径补出模态) */
let captureController: { setVisible(v: boolean): void } | null = null

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
  if (open) {
    for (const attr of OTHER_ACTIVE_ATTRS) document.documentElement.removeAttribute(attr)
    document.documentElement.setAttribute(ACTIVE_ATTR, '')
    document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
  } else {
    document.documentElement.removeAttribute(ACTIVE_ATTR)
    captureController?.setVisible(false)
  }
  for (const listener of panelOpenListeners) listener()
}

/** 打开任务视图;autoCapture=壳快捷键路径,同时带出捕获模态 */
export function openPanel(options: { autoCapture?: boolean } = {}): void {
  if (!panelOpen) setPanelOpen(true)
  if (options.autoCapture) captureController?.setVisible(true)
}

export function closePanel(): void {
  if (panelOpen) setPanelOpen(false)
}

export function togglePanel(): void {
  setPanelOpen(!panelOpen)
}

// ---- 视图挂载(apply 时一次;容器常驻 DOM,显隐走 html 属性) ----

/** 幂等注入 light DOM 规则(容器显隐 + 兄弟让位) */
function ensureViewStyle(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = VIEW_CSS
  document.head.appendChild(style)
}

/**
 * 在中列挂载任务视图并绑定让位协议。
 * @returns disposer 卸载视图与监听
 */
export function mountPanelView(): () => void {
  ensureViewStyle()
  let root: ReturnType<typeof createRoot> | undefined
  let container: HTMLDivElement | undefined

  const ensure = (): void => {
    if (container !== undefined) return
    const column = document.querySelector<HTMLElement>(COLUMN_SELECTOR)
    if (column === null) return
    container = document.createElement('div')
    container.setAttribute(VIEW_ATTR, '')
    container.setAttribute('data-dsh-plugin', 'dispatch')
    column.appendChild(container)
    const shadow = container.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = stylesCss + drawersCss + captureCss + SHELL_CSS
    shadow.appendChild(style)
    const mount = document.createElement('div')
    mount.className = 'panel-mount'
    shadow.appendChild(mount)
    const bridge = createApiBridge({ onCaptureHide: () => captureController?.setVisible(false) })
    ;(window as unknown as { dispatchApi: unknown }).dispatchApi = bridge
    root = createRoot(mount)
    root.render(
      <StrictMode>
        <PanelRoot />
      </StrictMode>,
    )
  }

  // 壳在启动落定后才挂中列,观察其到达
  const waitObserver = new MutationObserver(() => { ensure() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  // 兄弟面板激活 → 自行让位
  const onOtherActivate = (event: Event): void => {
    if ((event as CustomEvent).detail !== PANEL_NAME && panelOpen) setPanelOpen(false)
  }
  // 点侧栏会话/工作区/新会话行 → 中列还给对话(capture 相位,先于壳处理)
  const onClickSidebarRow = (event: MouseEvent): void => {
    if (!panelOpen) return
    const target = event.target as HTMLElement | null
    if (target === null) return
    if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) setPanelOpen(false)
  }
  document.addEventListener('click', onClickSidebarRow, true)
  document.addEventListener(ACTIVATE_EVENT, onOtherActivate)
  ensure()

  return () => {
    document.removeEventListener('click', onClickSidebarRow, true)
    document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
    waitObserver.disconnect()
    document.documentElement.removeAttribute(ACTIVE_ATTR)
    root?.unmount()
    root = undefined
    container?.remove()
    container = undefined
  }
}

function PanelRoot(): React.JSX.Element {
  const [captureVisible, setCaptureVisible] = useState(false)

  useEffect(() => {
    captureController = { setVisible: setCaptureVisible }
    return () => {
      captureController = null
    }
  }, [])
  const toggleCapture = useCallback(() => setCaptureVisible((v) => !v), [])
  // 点遮罩收起;从卡片内拖选文本落在遮罩上的 click 不算(有选区时忽略)
  const onBackdropClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    if (window.getSelection()?.toString()) return
    setCaptureVisible(false)
  }, [])

  return (
    <div className="panel-frame">
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
