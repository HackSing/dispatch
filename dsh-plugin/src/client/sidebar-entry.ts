/**
 * 侧栏入口注入,task-board 先例的三条纪律缺一不可:
 *   1. 模糊选择器定位(壳 DOM 类名带构建哈希,禁止精确类名);
 *   2. 纯 DOM 元素(非 React),不扰动壳的 reconciliation;
 *   3. 双 MutationObserver 自愈:body 级应对整树重建,root 级在重渲染挤掉
 *      节点时同帧重插;幂等靠 data-dispatch-sidebar-entry 查重。
 *
 * @module dsh-dispatch/client/sidebar-entry
 */

const ENTRY_ATTR = 'data-dispatch-sidebar-entry'

/** 候选按优先级排序;实机校准后保持模糊匹配,勿换成精确类名 */
const SIDEBAR_SELECTORS = ['[data-pane="sidebar"]', 'nav[class*="sidebar" i]', 'aside[class*="sidebar" i]', '[class*="sidebarCol" i]']

export interface SidebarEntryOptions {
  onOpen: () => void
}

export function installSidebarEntry({ onOpen }: SidebarEntryOptions): () => void {
  let button: HTMLButtonElement | null = null
  let bodyObserver: MutationObserver | null = null
  let rootObserver: MutationObserver | null = null
  let disposed = false

  function findSidebar(): HTMLElement | null {
    for (const selector of SIDEBAR_SELECTORS) {
      const found = document.querySelector<HTMLElement>(selector)
      if (found) return found
    }
    return null
  }

  function ensureEntry(): void {
    if (disposed) return
    if (document.querySelector(`[${ENTRY_ATTR}]`)) return
    const sidebar = findSidebar()
    if (!sidebar) return
    button = document.createElement('button')
    button.setAttribute(ENTRY_ATTR, '')
    button.type = 'button'
    button.textContent = '派单 Dispatch'
    button.title = '打开 Dispatch 任务面板'
    Object.assign(button.style, {
      display: 'block',
      width: 'calc(100% - 16px)',
      margin: '8px',
      padding: '8px 10px',
      border: 'none',
      borderRadius: '8px',
      background: 'rgba(0, 113, 227, 0.12)',
      color: '#0071e3',
      font: 'inherit',
      fontSize: '13px',
      textAlign: 'left',
      cursor: 'pointer',
    } satisfies Partial<CSSStyleDeclaration>)
    button.addEventListener('click', () => onOpen())
    sidebar.prepend(button)

    // root 级自愈:sidebar 自身重渲染把按钮挤掉时重插
    rootObserver?.disconnect()
    rootObserver = new MutationObserver(() => ensureEntry())
    rootObserver.observe(sidebar, { childList: true })
  }

  ensureEntry()

  // body 级自愈:整树重建(SPA 路由/会话切换)后重找 sidebar
  bodyObserver = new MutationObserver(() => ensureEntry())
  bodyObserver.observe(document.body, { childList: true, subtree: true })

  return () => {
    disposed = true
    bodyObserver?.disconnect()
    rootObserver?.disconnect()
    document.querySelector(`[${ENTRY_ATTR}]`)?.remove()
    button = null
  }
}
