import { app } from 'electron'
import log from 'electron-log/main'
import { join } from 'node:path'
import { resolvePaths, ensureDispatchDirs } from '@core/paths'
import { loadConfig } from '@core/config'
import { openDatabase } from '@core/db'
import { createTray } from './tray'
import { createMainWindow, showMainWindow } from './windows'
import { registerIpcHandlers } from './ipc-handlers'
import type { AppContext } from './context'

let ctx: AppContext | null = null

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())

  app.whenReady().then(() => {
    const paths = resolvePaths()
    ensureDispatchDirs(paths)

    log.initialize()
    log.transports.file.resolvePathFn = () => join(paths.logsDir, 'main.log')

    const config = loadConfig(paths.configFile)
    const db = openDatabase(paths.dbFile)
    ctx = { paths, config, db }

    registerIpcHandlers(ctx)
    createMainWindow()
    createTray()
    log.info(`Dispatch ${app.getVersion()} 启动,home=${paths.home}`)
  })

  // 常驻托盘:关窗不退出,退出只走托盘菜单
  app.on('window-all-closed', () => {})

  app.on('activate', () => showMainWindow())
}

export function getContext(): AppContext {
  if (!ctx) throw new Error('app context 尚未初始化')
  return ctx
}
