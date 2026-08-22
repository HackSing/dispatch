/**
 * 侧栏入口注入。呈现与插位照抄 task-board 先例
 * (@linxin666/dsh-client-ui-task-board 的 sidebar-entry-core.ts +
 * board.module.css):插在「新键会话」按钮(logoRow)之后、工作区浏览器之前,
 * 样式走壳的 dsw 设计令牌,与原生导航行同观感(含收起栏与 active 高亮)。
 * 三条纪律不变:
 *   1. 模糊选择器定位(壳 DOM 类名带构建哈希,禁止精确类名);
 *   2. 纯 DOM 元素(非 React),不扰动壳的 reconciliation;
 *   3. 双 MutationObserver 自愈:body 级应对整树重建,root 级在重渲染挤掉
 *      节点时同帧重插;幂等靠 data-dispatch-sidebar-entry 查重。
 *
 * @module dsh-dispatch/client/sidebar-entry
 */
import { isPanelOpen, subscribePanelOpen } from './panel'

const ENTRY_ATTR = 'data-dispatch-sidebar-entry'
const ENTRY_SELECTOR = `[${ENTRY_ATTR}]`
const STYLE_ID = 'dsh-dispatch-sidebar-entry-style'
/** 家族让位:与其它插件的侧栏行保持稳定相对顺序,本包排在家族块末尾 */
const FAMILY_SELECTORS = [ENTRY_SELECTOR, '[data-dsh-taskboard-entry]', '[data-dsh-ssh-entry]']

/** 14px 线性纸飞机,task-board ICON 同款画法,匹配壳 16px nav-icon 观感 */
const ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 1.3 10 14.7 7.3 8.7 1.3 6z"/><path d="M14.7 1.3 7.3 8.7"/></svg>'

/** 属性选择器作用域,无类名碰撞;颜色全部走 dsw 令牌,自动适配明暗/皮肤 */
const ENTRY_CSS = `
${ENTRY_SELECTOR} {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 32px;
  padding: 0 12px;
  background: transparent;
  border: none;
  border-radius: 8px;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  font-size: 13px;
  white-space: nowrap;
  transition: background-color 120ms ease, color 120ms ease;
}
${ENTRY_SELECTOR}:hover {
  background: var(--dsw-specific-sidebar-nav-item-hover);
  color: var(--dsw-alias-label-primary);
}
${ENTRY_SELECTOR}[data-active] {
  background: var(--dsw-specific-sidebar-nav-item-active);
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}
${ENTRY_SELECTOR}[data-active]:hover {
  background: var(--dsw-specific-sidebar-nav-item-active);
}
${ENTRY_SELECTOR}:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 2px;
}
${ENTRY_SELECTOR}:active {
  transform: translateY(1px);
}
${ENTRY_SELECTOR} .dispatch-entry-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
${ENTRY_SELECTOR} .dispatch-entry-label {
  overflow: hidden;
  text-overflow: ellipsis;
}
[data-dsh-frame][data-sidebar-collapsed] ${ENTRY_SELECTOR} {
  justify-content: center;
  padding: 0;
}
[data-dsh-frame][data-sidebar-collapsed] ${ENTRY_SELECTOR} .dispatch-entry-label {
  display: none;
}
`

/** 幂等注入入口样式(全局 <style>,规则全部锚定入口属性选择器) */
function ensureStyle(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = ENTRY_CSS
  document.head.appendChild(style)
}

/** 侧栏根:现壳 column > wrapper > root(logoRow 所属者),旧壳退回 column 首子元素 */
function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
  if (column === null) return undefined
  const logoOwner = column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement
  return logoOwner ?? (column.firstElementChild as HTMLElement | undefined)
}

/** 新键会话按钮:现壳嵌在 logoRow 内,旧壳是 root 的直接子按钮 */
function newSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  const nested = root.querySelector<HTMLButtonElement>('button[class*="newSession"]')
  if (nested !== null) return nested
  for (const child of root.children) {
    if (child.tagName === 'BUTTON') return child as HTMLButtonElement
  }
  return undefined
}

/** 行元素(游离按钮,壳就绪后一次性插入) */
function createEntry(onToggle: () => void): HTMLButtonElement {
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.setAttribute(ENTRY_ATTR, '')
  entry.setAttribute('data-dsh-plugin', 'dispatch')
  entry.setAttribute('data-dsh-part', 'sidebar-entry')
  entry.setAttribute('aria-label', '任务派单')
  entry.title = '打开 Dispatch 任务面板'
  entry.innerHTML = '<span class="dispatch-entry-icon">' + ICON
    + '</span><span class="dispatch-entry-label">任务派单</span>'
  entry.addEventListener('click', onToggle)
  return entry
}

/** 插到 logoRow 之后;家族行已存在时排家族块末尾,重渲染后相对顺序稳定 */
function placeEntry(root: HTMLElement, entry: HTMLButtonElement): boolean {
  const button = newSessionButton(root)
  if (button === undefined) return false
  if (entry.parentElement !== root) {
    const row = button.closest('[class*="logoRow"]')
    const base = (row !== null && row.parentElement === root) ? row : button
    const family = Array.from(root.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el.matches(FAMILY_SELECTORS.join(', ')),
    )
    const anchor = family.length > 0 ? family[family.length - 1]!.nextElementSibling : base.nextElementSibling
    root.insertBefore(entry, anchor)
  }
  return true
}

export interface SidebarEntryOptions {
  /** 点击行:开合切换(视图常驻 DOM,显隐走 html 属性) */
  onToggle: () => void
}

/**
 * 挂载侧栏入口:等壳渲染完成才插入,React 重渲染挤出节点时同帧重插;
 * 面板开着时行高亮(active 桥接 panel.tsx 的开合状态)。
 * @returns disposer 移除入口与观察器
 */
export function installSidebarEntry({ onToggle }: SidebarEntryOptions): () => void {
  // DOM 级幂等:重复 apply/HMR 重注入时保留既有行,不挂第二份
  if (document.querySelector(ENTRY_SELECTOR) !== null) {
    return () => {}
  }
  ensureStyle()
  const entry = createEntry(onToggle)
  let root: HTMLElement | undefined
  let placed = false

  const tryPlace = (): void => {
    if (root !== undefined && !root.isConnected) {
      // 壳整树重建:root 级观察者随旧树销毁,重查重来(body 级观察者兜底)
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    if (placed) {
      if (document.body.contains(entry)) return
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    root ??= sidebarRoot()
    if (root === undefined) return
    placed = placeEntry(root, entry)
    if (placed) {
      rootObserver.observe(root, { childList: true, subtree: true })
    }
  }

  // body 级兜底:整树重建后只有它能发现新侧栏;就位后短路于一次 contains 检查
  const waitObserver = new MutationObserver(() => { tryPlace() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  // root 级自愈:重渲染挤出节点时同帧重插(重绘前,无闪烁)
  const rootObserver = new MutationObserver(() => {
    if (root === undefined || !root.isConnected) {
      placed = false
      tryPlace()
      return
    }
    if (!root.contains(entry)) {
      placed = placeEntry(root, entry)
    }
  })

  // active 高亮桥接;注意 dataset.active=undefined 会物化成 "undefined" 导致
  // 常亮,关闭时必须 delete 属性
  const syncActive = (): void => {
    if (isPanelOpen()) entry.dataset.active = 'true'
    else delete entry.dataset.active
  }
  const unsubscribeActive = subscribePanelOpen(syncActive)
  syncActive()

  tryPlace()

  return () => {
    waitObserver.disconnect()
    rootObserver.disconnect()
    unsubscribeActive()
    entry.remove()
  }
}
