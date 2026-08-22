/**
 * dsh-dispatch — client half (source; packed into lib/client.js by
 * build-client.mjs)。loader 物化时调用 apply:中列挂载任务视图(task-board
 * 同款接管,常驻显隐),侧栏注入「任务派单」入口切换开合。
 *
 * 壳快捷键:dsh-buddy 注册系统级 globalShortcut 并在按下时前置窗口 + 派发
 * `dsh-buddy-hotkey` CustomEvent(旧壳无此事件,入口退化为侧栏按钮)。
 *
 * @module dsh-dispatch/client
 */
import { installSidebarEntry } from './sidebar-entry'
import { mountPanelView, openPanel, togglePanel } from './panel'

export function apply(): void {
  mountPanelView()
  installSidebarEntry({ onToggle: () => togglePanel() })
  window.addEventListener('dsh-buddy-hotkey', () => openPanel({ autoCapture: true }))
}
