import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Task } from '@shared/types'
import type { DispatchConfig } from '@core/config'
import type { DispatchPaths } from '@core/paths'
import type { ProjectStore, TaskStore } from '@core/db'
import { currentBranch } from '@core/gitops'
import { sanitizeName, shortId } from '@core/naming'

export interface RecoveryDeps {
  tasks: TaskStore
  projects: ProjectStore
  config: DispatchConfig
  paths: DispatchPaths
  /** 补跑入队,壳层接 Scheduler.enqueueNow 以共享 in-flight 去重 */
  enqueue: (taskId: string) => void
  /** 测试注入假时钟;缺省真实时钟 */
  now?: () => Date
}

export interface RecoveryReport {
  /** running/merging 残留 → failed(interrupted) */
  interrupted: string[]
  /** 孤儿 worktree 回填路径成功的任务 */
  reattached: string[]
  /** 过期 scheduled 按 missed_task_policy=run 入队 */
  missedRun: string[]
  /** 过期 scheduled 按 missed_task_policy=skip 落 failed(missed_skipped) */
  missedSkipped: string[]
  /** awaiting_merge 残留,交由调度器周期重试,此处仅登记 */
  awaitingMerge: string[]
  /** 单项恢复失败不阻断整体,错误在此汇报由壳层落日志 */
  errors: string[]
}

/**
 * spec §9 崩溃恢复,必须在 Scheduler.start() 之前执行:
 * ① running/merging 残留 → failed(interrupted),worktree 保留;
 * ② 按 worktrees/<project-name>/<task-id>/ 目录扫描孤儿 worktree,回填 db 缺失的路径;
 * ③ 过期 scheduled 按 missed_task_policy 补跑或跳过;awaiting_merge 交调度器重试。
 */
export async function recoverOnStartup(deps: RecoveryDeps): Promise<RecoveryReport> {
  const now = deps.now ?? (() => new Date())
  const report: RecoveryReport = {
    interrupted: [],
    reattached: [],
    missedRun: [],
    missedSkipped: [],
    awaitingMerge: [],
    errors: []
  }
  failInterrupted(deps, report, now)
  await reattachOrphanWorktrees(deps, report)
  handleMissedScheduled(deps, report, now)
  report.awaitingMerge = deps.tasks.listByStatus('awaiting_merge').map((t) => t.id)
  return report
}

function failInterrupted(deps: RecoveryDeps, report: RecoveryReport, now: () => Date): void {
  for (const status of ['running', 'merging'] as const) {
    for (const task of deps.tasks.listByStatus(status)) {
      deps.tasks.transition(task.id, 'failed', {
        failReason: 'interrupted',
        finishedAt: now().toISOString()
      })
      report.interrupted.push(task.id)
    }
  }
}

/**
 * 执行中途崩溃时 worktree_path/archive_dir 尚未入库(它们随 merging/failed 迁移落库),
 * 目录名即完整任务 id,能对上库中任务的经 attachRuntimePaths 回填。无主目录留给清理策略。
 */
async function reattachOrphanWorktrees(deps: RecoveryDeps, report: RecoveryReport): Promise<void> {
  const root = deps.paths.worktreesDir
  if (!existsSync(root)) return
  for (const projectDir of listSubdirs(root)) {
    for (const taskId of listSubdirs(join(root, projectDir))) {
      const task = deps.tasks.get(taskId)
      if (!task || task.worktreePath !== null) continue
      if (task.status !== 'failed' && task.status !== 'conflict' && task.status !== 'awaiting_merge')
        continue
      const worktreePath = join(root, projectDir, taskId)
      try {
        const branch = await currentBranch(worktreePath)
        deps.tasks.attachRuntimePaths(taskId, {
          worktreePath,
          branch: branch === 'HEAD' ? null : branch,
          ...(task.archiveDir === null
            ? { archiveDir: findArchiveDir(deps, task) }
            : {})
        })
        report.reattached.push(taskId)
      } catch (e) {
        report.errors.push(`回填 ${taskId} 失败: ${(e as Error).message}`)
      }
    }
  }
}

/** 归档目录名为 <本地日期>-<短 id>,同短 id 多次出现时取最新 */
function findArchiveDir(deps: RecoveryDeps, task: Task): string | null {
  const project = deps.projects.get(task.projectId)
  if (!project) return null
  const dir = join(deps.paths.archivesDir, sanitizeName(project.name))
  if (!existsSync(dir)) return null
  const suffix = `-${shortId(task.id)}`
  const matches = readdirSync(dir)
    .filter((name) => name.endsWith(suffix))
    .sort()
  return matches.length > 0 ? join(dir, matches[matches.length - 1]) : null
}

function handleMissedScheduled(deps: RecoveryDeps, report: RecoveryReport, now: () => Date): void {
  const startupMs = now().getTime()
  for (const task of deps.tasks.listByStatus('scheduled')) {
    if (task.triggerType !== 'at' || !task.triggerAt) continue
    if (Date.parse(task.triggerAt) >= startupMs) continue
    if (deps.config.missed_task_policy === 'run') {
      deps.enqueue(task.id)
      report.missedRun.push(task.id)
    } else {
      // 契约冻结:状态机无 scheduled→failed 直达,经 running 过渡落定
      deps.tasks.transition(task.id, 'running')
      deps.tasks.transition(task.id, 'failed', {
        failReason: 'missed_skipped',
        finishedAt: now().toISOString()
      })
      report.missedSkipped.push(task.id)
    }
  }
}

function listSubdirs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
}
