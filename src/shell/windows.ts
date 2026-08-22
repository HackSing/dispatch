import { BrowserWindow } from 'electron'
import { join } from 'node:path'

let mainWindow: BrowserWindow | null = null
let captureWindow: BrowserWindow | null = null
/** 系统对话框(选文件夹)会抢焦点,期间必须挂起捕获窗的失焦收起 */
let captureAutoHideSuspended = false

const CAPTURE_WIDTH = 560
/** W1c 增加子智能体选择器后控件条可能折两行,高度随之上调 */
const CAPTURE_HEIGHT = 250

function webPreferences(): Electron.WebPreferences {
  return {
    preload: join(__dirname, '../preload/index.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true
  }
}

export function createMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow

  mainWindow = new BrowserWindow({
    width: 960,
    height: 680,
    show: false,
    webPreferences: webPreferences()
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return mainWindow
}

export function showMainWindow(): void {
  const win = createMainWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** 捕获窗常驻隐藏(启动即预热),保证快捷键唤起 <300ms;panel 类型不进 Dock/任务切换 */
export function createCaptureWindow(): BrowserWindow {
  if (captureWindow && !captureWindow.isDestroyed()) return captureWindow

  captureWindow = new BrowserWindow({
    width: CAPTURE_WIDTH,
    height: CAPTURE_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hiddenInMissionControl: true,
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
    webPreferences: webPreferences()
  })
  captureWindow.setAlwaysOnTop(true, 'screen-saver')
  captureWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  captureWindow.on('blur', () => {
    if (!captureAutoHideSuspended) hideCaptureWindow()
  })
  captureWindow.on('closed', () => {
    captureWindow = null
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    captureWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/capture.html`)
  } else {
    captureWindow.loadFile(join(__dirname, '../renderer/capture.html'))
  }
  return captureWindow
}

export function showCaptureWindow(): void {
  const win = createCaptureWindow()
  win.center()
  win.show()
  win.focus()
}

export function hideCaptureWindow(): void {
  if (captureWindow && !captureWindow.isDestroyed() && captureWindow.isVisible()) {
    captureWindow.hide()
  }
}

export function toggleCaptureWindow(): void {
  const win = createCaptureWindow()
  if (win.isVisible() && win.isFocused()) {
    hideCaptureWindow()
  } else {
    showCaptureWindow()
  }
}

export async function withCaptureAutoHideSuspended<T>(fn: () => Promise<T>): Promise<T> {
  captureAutoHideSuspended = true
  try {
    return await fn()
  } finally {
    captureAutoHideSuspended = false
    if (captureWindow && !captureWindow.isDestroyed() && captureWindow.isVisible()) {
      captureWindow.focus()
    }
  }
}

export function getDialogParent(): BrowserWindow | null {
  if (captureWindow && !captureWindow.isDestroyed() && captureWindow.isVisible()) {
    return captureWindow
  }
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  return null
}
