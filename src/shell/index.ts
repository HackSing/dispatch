import { app, globalShortcut } from 'electron'
import log from 'electron-log/main'
import { join } from 'node:path'
import { resolvePaths, ensureDispatchDirs } from '@core/paths'
import { loadConfig } from '@core/config'
import { openDatabase, TaskStore, ProjectStore, DetectionStore } from '@core/db'
import { seedDefaultProject } from '@core/bootstrap'
import { createTray } from './tray'
import { createCaptureWindow, createMainWindow, showMainWindow, toggleCaptureWindow } from './windows'
import { broadcast, refreshAgentDetections, registerIpcHandlers } from './ipc-handlers'
import { ExecutionService } from './execution'
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
    const tasks = new TaskStore(db, (t) => broadcast('task:changed', { taskId: t.id, status: t.status }))
    const projects = new ProjectStore(db)
    const detections = new DetectionStore(db)
    ctx = {
      paths,
      config,
      db,
      tasks,
      projects,
      detections,
      hotkey: { accelerator: config.hotkey, registered: false }
    }

    registerIpcHandlers(ctx, new ExecutionService(ctx))
    createMainWindow()
    createCaptureWindow()
    createTray()

    // 注册失败不静默:状态入 ctx,主窗顶部横幅提示改键(dev-plan 风险 4)
    ctx.hotkey.registered = globalShortcut.register(config.hotkey, () => toggleCaptureWindow())
    if (!ctx.hotkey.registered) {
      log.warn(`全局快捷键 ${config.hotkey} 注册失败,可能被其他应用占用`)
    }

    // 首启种子 default 项目;git 初始化失败不建项目行,下次启动重试
    void seedDefaultProject(projects)
      .then((r) => {
        if (r.created) log.info(`default 项目已创建: ${r.project.path}`)
      })
      .catch((e: Error) => log.error(`default 项目初始化失败: ${e.message}`))

    // 启动检测异步跑,不阻塞窗口
    void refreshAgentDetections(ctx).catch((e: Error) => log.error(`agent 检测失败: ${e.message}`))

    log.info(`Dispatch ${app.getVersion()} 启动,home=${paths.home}`)
  })

  // 常驻托盘:关窗不退出,退出只走托盘菜单
  app.on('window-all-closed', () => {})

  app.on('activate', () => showMainWindow())

  app.on('will-quit', () => globalShortcut.unregisterAll())
}

export function getContext(): AppContext {
  if (!ctx) throw new Error('app context 尚未初始化')
  return ctx
}
