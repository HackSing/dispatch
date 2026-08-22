import { create } from 'zustand'
import type { AgentDetection, Project, Task } from '@shared/types'
import type { AppStatus, HotkeyStatus } from '@shared/ipc'

/** 主进程是唯一事实源,本 store 只做订阅镜像,不做本地状态推演(dev-plan §1.2) */
interface AppState {
  status: AppStatus | null
  hotkey: HotkeyStatus | null
  tasks: Task[]
  projects: Project[]
  detections: AgentDetection[]
  loadError: string | null
  loadAll: () => Promise<void>
  refreshTasks: () => Promise<void>
  refreshProjects: () => Promise<void>
  /** 订阅主进程事件,返回退订函数 */
  subscribe: () => () => void
}

export const useAppStore = create<AppState>((set, get) => ({
  status: null,
  hotkey: null,
  tasks: [],
  projects: [],
  detections: [],
  loadError: null,

  async loadAll() {
    try {
      const [status, hotkey, tasks, projects, detections] = await Promise.all([
        window.dispatchApi.invoke('app:status', undefined),
        window.dispatchApi.invoke('app:hotkey-status', undefined),
        window.dispatchApi.invoke('task:list', undefined),
        window.dispatchApi.invoke('project:list', undefined),
        window.dispatchApi.invoke('agent:detections', undefined)
      ])
      set({ status, hotkey, tasks, projects, detections, loadError: null })
    } catch (e) {
      set({ loadError: (e as Error).message })
    }
  },

  async refreshTasks() {
    set({ tasks: await window.dispatchApi.invoke('task:list', undefined) })
  },

  async refreshProjects() {
    set({ projects: await window.dispatchApi.invoke('project:list', undefined) })
  },

  subscribe() {
    const offTask = window.dispatchApi.on('task:changed', () => {
      void get().refreshTasks()
    })
    const offDetections = window.dispatchApi.on('agent:detections-changed', ({ detections }) => {
      set({ detections })
    })
    return () => {
      offTask()
      offDetections()
    }
  }
}))
