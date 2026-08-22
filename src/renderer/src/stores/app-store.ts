import { create } from 'zustand'
import type { AgentDetection, AgentId, Project, Task } from '@shared/types'
import type { AgentSessionCapability, AppStatus, HotkeyStatus } from '@shared/ipc'

/** 主进程是唯一事实源,本 store 只做订阅镜像,不做本地状态推演(dev-plan §1.2) */
interface AppState {
  status: AppStatus | null
  hotkey: HotkeyStatus | null
  tasks: Task[]
  projects: Project[]
  detections: AgentDetection[]
  /** 会话能力(config 派生,主进程算好),null = 尚未加载 */
  capabilities: Record<AgentId, AgentSessionCapability> | null
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
  capabilities: null,
  loadError: null,

  async loadAll() {
    try {
      const [status, hotkey, tasks, projects, detections, capabilities] = await Promise.all([
        window.dispatchApi.invoke('app:status', undefined),
        window.dispatchApi.invoke('app:hotkey-status', undefined),
        window.dispatchApi.invoke('task:list', undefined),
        window.dispatchApi.invoke('project:list', undefined),
        window.dispatchApi.invoke('agent:detections', undefined),
        window.dispatchApi.invoke('agent:capabilities', undefined)
      ])
      set({ status, hotkey, tasks, projects, detections, capabilities, loadError: null })
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
    // 捕获窗新建项目后,主窗项目分组必须跟上,否则其下任务整组不可见
    const offProject = window.dispatchApi.on('project:changed', () => {
      void get().refreshProjects()
    })
    const offDetections = window.dispatchApi.on('agent:detections-changed', ({ detections }) => {
      set({ detections })
    })
    return () => {
      offTask()
      offProject()
      offDetections()
    }
  }
}))
