import { app, Menu, nativeImage, Tray } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { showMainWindow } from './windows'

let tray: Tray | null = null

function trayIcon(): Electron.NativeImage {
  const iconPath = join(app.getAppPath(), 'resources/icons/trayTemplate.png')
  if (existsSync(iconPath)) {
    const img = nativeImage.createFromPath(iconPath)
    img.setTemplateImage(true)
    return img
  }
  return nativeImage.createEmpty()
}

export function createTray(): Tray {
  if (tray) return tray
  tray = new Tray(trayIcon())
  if (tray.getBounds().width === 0) tray.setTitle('派') // 图标缺失时的文字兜底(仅 macOS)
  tray.setToolTip('Dispatch')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 Dispatch', click: () => showMainWindow() },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ])
  )
  tray.on('click', () => showMainWindow())
  return tray
}
