import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import type { AgentDetection, AgentId, Task } from '@shared/types'
import type {
  AgentSessionCapability,
  AppStatus,
  EventChannel,
  EventMap,
  InvokeChannel,
  InvokeMap
} from '@shared/ipc'
import { AGENT_IDS } from '@shared/types'
import { SCHEMA_VERSION } from '@core/db'
import { runDetections } from '@core/agents/detection'
import { followUpTransport, renderSessionArgs, supportsTerminalResume } from '@core/agents/session'
import { getPlatformOps } from '@core/platform'
import { loadUiState, saveUiState } from '@core/ui-state'
import {
  abandonTask,
  cancelScheduled,
  deleteTask,
  editTask,
  rerunFailedTask,
  toggleTodo
} from '@core/task-edit'
import { cleanupTaskWorkspace } from '@core/executor/cleanup'
import { readTaskArchive } from '@core/archive/read'
import { getDialogParent, hideCaptureWindow, withCaptureAutoHideSuspended } from './windows'
import type { AppContext } from './context'
import type { ExecutionService } from './execution'
import type { SessionService } from './session-service'

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

/** 检测有 IO 与子进程开销,并发触发时复用在途 Promise */
let detectionInFlight: Promise<AgentDetection[]> | null = null

export function refreshAgentDetections(ctx: AppContext): Promise<AgentDetection[]> {
  detectionInFlight ??= runDetections(ctx.config.agents, getPlatformOps(), ctx.detections)
    .then((list) => {
      broadcast('agent:detections-changed', { detections: list })
      return list
    })
    .finally(() => {
      detectionInFlight = null
    })
  return detectionInFlight
}

export function registerIpcHandlers(
  ctx: AppContext,
  execution: ExecutionService,
  sessions: SessionService
): void {
  handle('app:status', (): AppStatus => {
    return {
      version: app.getVersion(),
      dbSchemaVersion: SCHEMA_VERSION,
      dispatchHome: ctx.paths.home,
      platform: process.platform
    }
  })

  handle('app:hotkey-status', () => ctx.hotkey)

  handle('task:create', (payload) => {
    if (!payload.text.trim()) throw new Error('任务文本不能为空')
    const task = ctx.tasks.create({
      text: payload.text,
      projectId: payload.projectId,
      agent: payload.agent,
      subAgent: payload.subAgent,
      triggerType: payload.triggerType,
      triggerAt: payload.triggerAt
    })
    execution.maybeRunImmediate(task)
    return task
  })

  handle('task:list', () => ctx.tasks.list())

  handle('task:update', ({ id, ...patch }) => editTask(ctx.tasks, id, patch))

  handle('task:toggle-todo', ({ id }) => toggleTodo(ctx.tasks, id))

  handle('task:cancel', ({ id }) => cancelScheduled(ctx.tasks, id))

  handle('task:run-now', ({ id }) => {
    const task = ctx.tasks.get(id)
    if (!task) throw new Error(`任务不存在: ${id}`)
    if (task.status !== 'scheduled') throw new Error(`任务状态 ${task.status} 不可立即执行`)
    if (!task.agent) throw new Error('任务未指定 agent,请先编辑补充')
    execution.enqueue(task.id)
    return task
  })

  handle('task:rerun', async ({ id }) => {
    const task = await rerunFailedTask({ tasks: ctx.tasks, projects: ctx.projects }, id)
    execution.maybeRunImmediate(task)
    return task
  })

  // 放弃 = 明确不要了:置败后同步清理 worktree 与分支;清理失败时任务已是 failed,
  // 错误上抛给 UI,用户可经「清理 worktree」按钮重试(cleanupTaskWorkspace 可重入)
  handle('task:abandon', async ({ id }) => {
    abandonTask(ctx.tasks, id)
    return cleanupTaskWorkspace({ tasks: ctx.tasks, projects: ctx.projects }, id)
  })

  handle('task:cleanup-worktree', ({ id }) =>
    cleanupTaskWorkspace({ tasks: ctx.tasks, projects: ctx.projects }, id)
  )

  handle('task:interrupt', ({ id }) => {
    const task = ctx.tasks.get(id)
    if (!task) throw new Error(`任务不存在: ${id}`)
    if (task.status !== 'running') throw new Error(`任务状态 ${task.status} 不可中断`)
    if (sessions.workingDirOf(id)) throw new Error('面板会话请在面板内终止或放弃')
    if (!execution.interrupt(id)) {
      throw new Error('当前阶段不可中断(可能正在合并),稍候再试')
    }
  })

  // 删行不走 TaskStore.onChange(避免误发失败通知),完成后显式广播触发列表刷新
  handle('task:delete', async ({ id }) => {
    const task = ctx.tasks.get(id)
    if (!task) throw new Error(`任务不存在: ${id}`)
    await deleteTask({ tasks: ctx.tasks, projects: ctx.projects }, id)
    broadcast('task:changed', { taskId: id, status: task.status })
  })

  handle('task:follow-up-start', ({ parentId }) => sessions.start(parentId))

  handle('task:follow-up-send', ({ id, text }) => sessions.send(id, text))

  handle('task:follow-up-finish', ({ id }) => sessions.finish(id))

  handle('task:follow-up-abandon', ({ id }) => sessions.abandon(id))

  // 终端逃生舱:活跃面板任务用会话工作目录,其余任务 worktree 存活则 worktree,否则项目目录
  handle('task:open-session-terminal', async ({ id }) => {
    const task = ctx.tasks.get(id)
    if (!task) throw new Error(`任务不存在: ${id}`)
    if (!task.sessionId) throw new Error('该任务没有可续接的会话')
    if (!task.agent) throw new Error('该任务没有 agent')
    const agentConfig = ctx.config.agents[task.agent]
    if (!agentConfig?.interactive_resume_cmd) {
      throw new Error(`agent ${task.agent} 未配置终端续会话命令`)
    }
    const command = renderSessionArgs([agentConfig.interactive_resume_cmd], task.sessionId)[0]
    const cwd = terminalCwd(ctx, sessions, task)
    await getPlatformOps().openTerminal(cwd, command)
  })

  handle('agent:capabilities', () => {
    const result = {} as Record<AgentId, AgentSessionCapability>
    for (const id of AGENT_IDS) {
      const cfg = ctx.config.agents[id]
      result[id] = {
        followUp: cfg ? followUpTransport(cfg) !== null : false,
        terminal: cfg ? supportsTerminalResume(cfg) : false
      }
    }
    return result
  })

  handle('task:retry-merge', ({ id }) => {
    const task = ctx.tasks.get(id)
    if (!task) throw new Error(`任务不存在: ${id}`)
    if (task.status !== 'awaiting_merge' && task.status !== 'conflict') {
      throw new Error(`任务状态 ${task.status} 不可重试合并`)
    }
    // 契约:立即返回当前任务,合并异步进行,进展经 task:changed 广播
    execution.retryMerge(id)
    return task
  })

  handle('task:archive', ({ id }) => {
    const task = ctx.tasks.get(id)
    if (!task) throw new Error(`任务不存在: ${id}`)
    return readTaskArchive(task.archiveDir)
  })

  handle('task:open-archive', async ({ id }) => {
    const task = ctx.tasks.get(id)
    if (!task) throw new Error(`任务不存在: ${id}`)
    if (!task.archiveDir) throw new Error('该任务尚无归档目录')
    const err = await shell.openPath(task.archiveDir)
    if (err) throw new Error(`打开归档目录失败: ${err}`)
  })

  handle('project:list', () => ctx.projects.list())

  handle('project:create', (payload) => {
    const path = payload.path.trim()
    if (!path) throw new Error('项目路径不能为空')
    const existing = ctx.projects.list().find((p) => p.path === path)
    if (existing) return existing
    return ctx.projects.create({ name: payload.name?.trim() || basename(path), path })
  })

  handle('project:pick-directory', () => {
    return withCaptureAutoHideSuspended(async () => {
      const options: Electron.OpenDialogOptions = {
        title: '选择项目文件夹',
        properties: ['openDirectory', 'createDirectory']
      }
      const parent = getDialogParent()
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
    })
  })

  handle('agent:detections', () => ctx.detections.list())

  handle('agent:refresh', () => refreshAgentDetections(ctx))

  handle('ui-state:get', () => loadUiState(ctx.paths.uiStateFile))

  handle('ui-state:set', (patch) => saveUiState(ctx.paths.uiStateFile, patch))

  handle('capture:hide', () => hideCaptureWindow())
}

function terminalCwd(ctx: AppContext, sessions: SessionService, task: Task): string {
  const active = sessions.workingDirOf(task.id)
  if (active) return active
  if (task.worktreePath && existsSync(task.worktreePath)) return task.worktreePath
  const project = ctx.projects.get(task.projectId)
  if (!project) throw new Error(`任务关联项目不存在: ${task.projectId}`)
  return project.path
}
