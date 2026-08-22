/**
 * dsh-dispatch — client half (source; packed into lib/client.js by
 * build-client.mjs). loader 物化时调用 apply:侧栏注入「派单」入口,点击后
 * body 级 Shadow DOM 面板承载完整任务 UI(renderer 源码级复用)。
 *
 * @module dsh-dispatch/client
 */
import { installSidebarEntry } from './sidebar-entry'
import { openPanel } from './panel'

export function apply(): void {
  installSidebarEntry({ onOpen: openPanel })
}
