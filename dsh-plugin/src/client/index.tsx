/**
 * dsh-dispatch — client half (source; packed into lib/client.js by
 * build-client.mjs). loader 物化时调用 apply:侧栏注入「派单」入口,点击后
 * body 级 Shadow DOM 面板承载完整任务 UI(renderer 源码级复用)。
 *
 * 壳快捷键:dsh-buddy 注册系统级 globalShortcut 并在按下时前置窗口 + 派发
 * `dsh-buddy-hotkey` CustomEvent(旧壳无此事件,入口退化为侧栏按钮)。
 *
 * @module dsh-dispatch/client
 */
import { installSidebarEntry } from './sidebar-entry'
import { openPanel } from './panel'

export function apply(): void {
  installSidebarEntry({ onOpen: () => openPanel() })
  window.addEventListener('dsh-buddy-hotkey', () => openPanel({ autoCapture: true }))
}
