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
 * project:pick-directory 经 api-bridge 拦截为面板内目录选择模态:先探测
 * project:browse-dir(dsh directoryPicker browse 能力),成功为面包屑目录
 * 浏览器,任何失败静默落回手输形态
 * (window.prompt 在 Electron 渲染进程不可用,浏览器与壳统一走面板模态)。
 *
 * @module dsh-dispatch/client/panel
 */
import React, { StrictMode, useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { DirectoryBrowse, DispatchApi } from '../../../src/shared/ipc'
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
/* 目录输入模态(拦截 project:pick-directory):与捕获模态同层同居中,卡片更紧凑;
   输入框观感取 renderer 表单控件既有值(边框/圆角/焦点环同 styles.css) */
.path-modal-card {
  width: min(440px, 100%);
  padding: 14px 16px;
  border-radius: 12px;
  background: #f8f8fa;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.35);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.path-modal-input {
  font: inherit;
  width: 100%;
  padding: 5px 8px;
  border: 0.5px solid rgba(0, 0, 0, 0.16);
  border-radius: 6px;
  background: #fff;
  color: inherit;
}
.path-modal-input:focus {
  outline: 2px solid rgba(10, 132, 255, 0.35);
  outline-offset: 0;
}
.path-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
/* 目录浏览器形态:面包屑行 + 列表区内部滚动;
   取值镜像 styles.css 既有值(0.5px 边框 / #f5f5f7 hover / #8e8e93 弱字 / #d70015 错误) */
.path-modal-crumbs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  font-size: 12px;
}
.path-modal-crumb {
  border: none;
  background: none;
  padding: 2px 4px;
  border-radius: 4px;
  font-size: inherit;
  color: #007aff;
}
.path-modal-crumb:not(:last-child)::after {
  content: '›';
  margin-left: 8px;
  color: #8e8e93;
}
.path-modal-crumb:last-child {
  color: #1d1d1f;
  font-weight: 600;
}
.path-modal-crumb:hover:not(:disabled) {
  background: #f5f5f7;
}
.path-modal-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: 40vh;
  overflow-y: auto;
  padding: 3px;
  border: 0.5px solid rgba(0, 0, 0, 0.16);
  border-radius: 6px;
  background: #fff;
}
.path-modal-row {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: none;
  padding: 4px 8px;
  border-radius: 5px;
  font-size: 12.5px;
  line-height: 1.4;
  color: inherit;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.path-modal-row:hover:not(:disabled) {
  background: #f5f5f7;
}
.path-modal-crumb:disabled,
.path-modal-row:disabled {
  opacity: 0.5;
  cursor: default;
}
.path-modal-note {
  padding: 4px 8px;
  font-size: 12px;
  color: #8e8e93;
}
.path-modal-list-error {
  padding: 4px 8px;
  font-size: 12px;
  color: #d70015;
}
`

// ---- 开合状态(纯 DOM 同步切换,不进 React——与 task-board controller 同语义) ----

const panelOpenListeners = new Set<() => void>()
let panelOpen = false
/** 已挂视图的捕获模态开关(关视图时顺手收起模态;快捷键路径补出模态) */
let captureController: { setVisible(v: boolean): void } | null = null
/** 已挂视图的目录输入模态控制器(PanelRoot 挂载时注册,供 api-bridge pickDirectory 接线) */
let pathPickerController: { pick: () => Promise<string | null> } | null = null

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
    const bridge = createApiBridge({
      onCaptureHide: () => captureController?.setVisible(false),
      // 桥在 React 挂载前创建,回调经模块级控制器延迟接到 PanelRoot 的模态
      pickDirectory: () => {
        if (pathPickerController === null) {
          return Promise.reject(new Error('面板视图尚未挂载,目录输入模态不可用'))
        }
        return pathPickerController.pick()
      },
    })
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
  // 目录选择模态:持有 pickDirectory 返回 Promise 的 resolver;null = 未打开
  const [pathDialog, setPathDialog] = useState<{ resolve: (path: string | null) => void } | null>(null)

  useEffect(() => {
    captureController = { setVisible: setCaptureVisible }
    return () => {
      captureController = null
    }
  }, [])

  useEffect(() => {
    pathPickerController = {
      pick: () =>
        new Promise<string | null>((resolve) => {
          // 重入守卫:模态已开时旧 resolver 以取消收口,避免上一次调用的 Promise 悬挂
          setPathDialog((prev) => {
            prev?.resolve(null)
            return { resolve }
          })
        }),
    }
    return () => {
      pathPickerController = null
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
      {pathDialog !== null ? (
        <PathPickerModal
          finish={(value) => {
            pathDialog.resolve(value)
            setPathDialog(null)
          }}
        />
      ) : null}
    </div>
  )
}

/** 面板自身的桥实例:mountPanelView 先于 React 树挂到 window */
function panelApi(): DispatchApi {
  return (window as unknown as { dispatchApi: DispatchApi }).dispatchApi
}

/**
 * 目录选择模态:打开时先探测 project:browse-dir,成功为浏览形态
 * (面包屑 + 子目录下钻),任何失败静默落回手输形态;Esc/遮罩取消两形态通用。
 * @param finish - 以选中路径收口(null = 取消),由 PanelRoot 负责关模态
 */
function PathPickerModal({ finish }: { finish: (path: string | null) => void }): React.JSX.Element {
  // loading = 打开后探测 browse 能力;browse = 目录浏览器;manual = 手输(探测失败兜底或主动切换)
  const [mode, setMode] = useState<'loading' | 'browse' | 'manual'>('loading')
  const [listing, setListing] = useState<DirectoryBrowse | null>(null)
  /** 在途列举(探测或下钻/面包屑导航):期间禁用面包屑与列表行点击 */
  const [busy, setBusy] = useState(false)
  /** 单次列举失败(如目录不可读):列表区内联显示,停留原级 */
  const [listError, setListError] = useState<string | null>(null)
  const [pathValue, setPathValue] = useState('')

  // 打开即探测;任何失败(宿主无 directoryPicker、非 browse 形态、runtime 未启动等)静默落回手输
  useEffect(() => {
    let cancelled = false
    setBusy(true)
    panelApi()
      .invoke('project:browse-dir', {})
      .then((res) => {
        if (cancelled) return
        setListing(res)
        setMode('browse')
      })
      .catch(() => {
        if (!cancelled) setMode('manual')
      })
      .finally(() => {
        if (!cancelled) setBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Esc 取消两形态通用(keydown 是 composed 事件,可跨 shadow DOM 到 document)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') finish(null)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [finish])

  const navigateTo = useCallback(async (path: string): Promise<void> => {
    setBusy(true)
    setListError(null)
    try {
      setListing(await panelApi().invoke('project:browse-dir', { path }))
    } catch (err) {
      // 单级列举失败(如目录不可读):停留原级,错误内联
      setListError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [])

  // 取消走模态自身遮罩的 onClick;shadow DOM 下不挂 document 级外点监听
  const onBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>): void => {
      if (e.target !== e.currentTarget) return
      if (window.getSelection()?.toString()) return
      finish(null)
    },
    [finish],
  )

  const confirmManual = useCallback((): void => {
    const trimmed = pathValue.trim()
    // 空串按取消处理(收口 null),与原对话框语义一致
    finish(trimmed === '' ? null : trimmed)
  }, [finish, pathValue])

  const visibleEntries = listing?.entries.filter((entry) => !entry.hidden) ?? []

  return (
    <div className="capture-modal-layer" onClick={onBackdropClick}>
      <div className="path-modal-card" onClick={(e) => e.stopPropagation()}>
        {mode === 'browse' && listing !== null ? (
          <>
            <div className="path-modal-crumbs">
              {listing.crumbs.map((crumb) => (
                <button
                  key={crumb.path}
                  className="path-modal-crumb"
                  disabled={busy}
                  onClick={() => void navigateTo(crumb.path)}
                >
                  {crumb.name}
                </button>
              ))}
            </div>
            <div className="path-modal-list">
              {listError !== null ? <div className="path-modal-list-error">{listError}</div> : null}
              {visibleEntries.map((entry) => (
                <button
                  key={entry.path}
                  className="path-modal-row"
                  disabled={busy}
                  onClick={() => void navigateTo(entry.path)}
                >
                  {entry.name}
                </button>
              ))}
              {visibleEntries.length === 0 && listError === null && !busy ? (
                <div className="path-modal-note">无子目录</div>
              ) : null}
              {listing.truncated ? (
                <div className="path-modal-note">目录过多仅显示部分,可切换手动输入</div>
              ) : null}
            </div>
            <div className="path-modal-actions">
              <button
                className="btn"
                onClick={() => {
                  setPathValue(listing.path)
                  setMode('manual')
                }}
              >
                手动输入
              </button>
              <button className="btn" onClick={() => finish(null)}>
                取消
              </button>
              <button className="btn primary" onClick={() => finish(listing.path)}>
                就选这里
              </button>
            </div>
          </>
        ) : mode === 'manual' ? (
          <>
            <input
              className="path-modal-input"
              type="text"
              autoFocus
              placeholder="输入项目文件夹的绝对路径,如 /Users/you/projects/demo"
              value={pathValue}
              onChange={(e) => setPathValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmManual()
              }}
            />
            <div className="path-modal-actions">
              <button className="btn" onClick={() => finish(null)}>
                取消
              </button>
              <button className="btn primary" onClick={confirmManual}>
                确定
              </button>
            </div>
          </>
        ) : (
          <div className="path-modal-note">正在加载目录…</div>
        )}
      </div>
    </div>
  )
}
