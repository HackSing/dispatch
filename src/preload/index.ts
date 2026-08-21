import { contextBridge, ipcRenderer } from 'electron'
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  type DispatchApi,
  type EventChannel,
  type InvokeChannel
} from '@shared/ipc'

/** 只放行契约内的 channel,渲染层拿不到任意 IPC 通道 */
const api: DispatchApi = {
  invoke(channel, payload) {
    if (!INVOKE_CHANNELS.includes(channel as InvokeChannel)) {
      return Promise.reject(new Error(`unknown invoke channel: ${channel}`))
    }
    return ipcRenderer.invoke(channel, payload)
  },
  on(channel, listener) {
    if (!EVENT_CHANNELS.includes(channel as EventChannel)) {
      throw new Error(`unknown event channel: ${channel}`)
    }
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown): void =>
      listener(payload as Parameters<typeof listener>[0])
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  }
}

contextBridge.exposeInMainWorld('dispatchApi', api)
