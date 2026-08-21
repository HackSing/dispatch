import { app, BrowserWindow, ipcMain } from 'electron'
import type { AppStatus, EventChannel, EventMap, InvokeChannel, InvokeMap } from '@shared/ipc'
import { SCHEMA_VERSION } from '@core/db'
import type { AppContext } from './context'

/** 类型化 handle 注册:channel 与载荷形状由 @shared/ipc 契约约束 */
function handle<C extends InvokeChannel>(
  channel: C,
  handler: (payload: InvokeMap[C]['req']) => InvokeMap[C]['res'] | Promise<InvokeMap[C]['res']>
): void {
  ipcMain.handle(channel, (_event, payload) => handler(payload))
}

export function broadcast<C extends EventChannel>(channel: C, payload: EventMap[C]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

export function registerIpcHandlers(ctx: AppContext): void {
  handle('app:status', (): AppStatus => {
    return {
      version: app.getVersion(),
      dbSchemaVersion: SCHEMA_VERSION,
      dispatchHome: ctx.paths.home,
      platform: process.platform
    }
  })
}
