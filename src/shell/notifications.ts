import { Notification } from 'electron'
import log from 'electron-log/main'
import type { Task, TaskStatus } from '@shared/types'
import { showMainWindow } from './windows'
import { broadcast } from './ipc-handlers'

/** spec §3.2 通知四事件;其余状态静默 */
const NOTIFY_TITLES: Partial<Record<TaskStatus, string>> = {
  done: '任务完成',
  failed: '任务失败',
  conflict: '合并冲突',
  awaiting_merge: '等待合并'
}

const TITLE_TEXT_MAX = 40

/** 进程内已见状态,保证仅状态「进入」时通知一次;onChange 不带前值,只能在此对比 */
const lastSeenStatus = new Map<string, TaskStatus>()

function firstLine(text: string): string {
  const line = text.split('\n')[0].trim()
  return line.length > TITLE_TEXT_MAX ? `${line.slice(0, TITLE_TEXT_MAX)}…` : line
}

function notificationBody(task: Task): string {
  switch (task.status) {
    case 'done':
      return task.mergedAt ? '执行成功,已合并回基线分支' : '执行成功'
    case 'failed':
      return `失败原因:${task.failReason ?? '未知'}`
    case 'conflict':
      return `合并冲突,worktree 已保留:${task.worktreePath ?? '(未知路径)'},请查看冲突报告处理`
    case 'awaiting_merge':
      return task.failReason === 'base_checked_out_elsewhere'
        ? '执行成功,但基线分支被其他工作区检出,暂缓合并;可稍后重试'
        : '执行成功,但主工作区有未提交改动,暂缓合并;清理后可重试'
    default:
      return ''
  }
}

/**
 * TaskStore onChange 挂载点:进入 done/failed/conflict/awaiting_merge 时发系统通知。
 * 通知不可用(未打包/无权限)只记日志不抛错,不能影响状态流转与广播。
 */
export function notifyTaskStatusChange(task: Task): void {
  const prev = lastSeenStatus.get(task.id)
  lastSeenStatus.set(task.id, task.status)
  if (prev === task.status) return
  const title = NOTIFY_TITLES[task.status]
  if (!title) return
  if (!Notification.isSupported()) {
    log.warn(`系统通知不可用,跳过:[${title}] ${firstLine(task.text)}`)
    return
  }
  try {
    const notification = new Notification({
      title: `${title}:${firstLine(task.text)}`,
      body: notificationBody(task)
    })
    notification.on('click', () => {
      showMainWindow()
      broadcast('ui:open-task', { taskId: task.id })
    })
    notification.show()
  } catch (e) {
    log.warn(`系统通知发送失败: ${(e as Error).message}`)
  }
}
