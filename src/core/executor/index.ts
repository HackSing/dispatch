import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentId, Project, Task, TaskPhase } from '@shared/types'
import type { DispatchConfig } from '@core/config'
import type { DispatchPaths } from '@core/paths'
import type { ProjectStore, TaskStore } from '@core/db'
import type { AgentAdapter, TaskResult } from '@core/agents/types'
import { createArchive, OutputLog } from '@core/archive'
import { loadPromptTemplate, renderPrompt } from '@core/prompt'
import { runShell } from '@core/proc/shell'
import {
  createTaskWorktree,
  currentBranch,
  isGitRepo,
  mergeFlow,
  removeWorktree,
  writeConflictReport
} from '@core/gitops'
import type { KeyedLock, Semaphore } from './locks'
import { runWorkflow, type WorkflowHost } from './workflow'

export interface ExecutorDeps {
  tasks: TaskStore
  projects: ProjectStore
  config: DispatchConfig
  paths: DispatchPaths
  adapterFor: (agent: AgentId) => AgentAdapter
  semaphore: Semaphore
  mergeLocks: KeyedLock
  /** 测试注入假时钟;缺省真实时钟 */
  now?: () => Date
  /** 应用内置模板路径(单文件形态,指向 default.md),shell 层传入;缺省走 prompt 模块兜底 */
  builtinPromptFile?: string
  /**
   * W1b 追加:内置模板目录(含 default.md 与三个 wf-*.md),工作流路径按 wf-<phase>.md 从中解析。
   * 与 builtinPromptFile 的关系:builtinPromptFile 是既有单文件形态,继续被单点路径独占消费
   * (保持零语义变更);本字段是其目录化扩展,仅工作流路径消费。shell 层两者都传时必须指向
   * 同一份内置资源,即 builtinPromptFile === join(builtinPromptsDir, 'default.md')。
   */
  builtinPromptsDir?: string
  /** 测试用超时覆盖;缺省 config.task_timeout_min */
  taskTimeoutMs?: number
  /** W1b 追加:测试用工作流阶段超时覆盖(毫秒);缺省 config.workflow_phase_timeout_min[phase] * 60_000 */
  workflowPhaseTimeoutsMs?: Partial<Record<TaskPhase, number>>
}

export interface ExecContext {
  deps: ExecutorDeps
  task: Task
  project: Project
  git: boolean
  baseBranch: string | null
  archiveDir: string
  log: OutputLog
  worktreePath: string | null
  branch: string | null
  now: () => Date
}

interface GitInfo {
  git: boolean
  baseBranch: string | null
  error: string | null
}

/** 状态检查之外不抛错:错误延迟到 running 后转任务失败(scheduled→failed 非法迁移) */
async function detectGitInfo(project: Project): Promise<GitInfo> {
  if (!existsSync(project.path)) {
    return { git: false, baseBranch: null, error: `project_path_missing: ${project.path}` }
  }
  if (!(await isGitRepo(project.path))) return { git: false, baseBranch: null, error: null }
  try {
    const base = project.baseBranch ?? (await currentBranch(project.path))
    if (base === 'HEAD') {
      return { git: true, baseBranch: null, error: 'detached_head: 无法确定 base 分支' }
    }
    return { git: true, baseBranch: base, error: null }
  } catch (e) {
    return { git: true, baseBranch: null, error: `base_branch_unresolved: ${(e as Error).message}` }
  }
}

/** 单任务执行编排:Phase0 → prompt → agent 运行 → 完成判定 → 合并/归档收尾 */
export async function runTask(deps: ExecutorDeps, taskId: string): Promise<Task> {
  const task = deps.tasks.get(taskId)
  if (!task) throw new Error(`任务不存在: ${taskId}`)
  if (task.status !== 'scheduled') throw new Error(`任务 ${taskId} 状态 ${task.status} 不可执行`)
  if (!task.agent) throw new Error(`任务 ${taskId} 未指定 agent`)
  const project = deps.projects.get(task.projectId)
  if (!project) throw new Error(`任务 ${taskId} 关联项目不存在: ${task.projectId}`)
  const release = await deps.semaphore.acquire()
  try {
    return await execute(deps, task, project)
  } finally {
    release()
  }
}

async function execute(deps: ExecutorDeps, task: Task, project: Project): Promise<Task> {
  const now = deps.now ?? (() => new Date())
  const info = await detectGitInfo(project)
  const running = deps.tasks.transition(task.id, 'running', {
    startedAt: now().toISOString(),
    baseBranch: info.baseBranch
  })
  const { archiveDir } = createArchive(deps.paths, project, running, {
    vcs: info.git ? 'git' : 'no_vcs',
    now: now()
  })
  const ctx: ExecContext = {
    deps,
    task: running,
    project,
    git: info.git,
    baseBranch: info.baseBranch,
    archiveDir,
    log: new OutputLog(archiveDir),
    worktreePath: null,
    branch: null,
    now
  }
  try {
    if (info.error) return failTask(ctx, info.error)
    return await runPhases(ctx)
  } catch (e) {
    return failCurrent(ctx, e as Error)
  } finally {
    await ctx.log.close()
  }
}

async function runPhases(ctx: ExecContext): Promise<Task> {
  let cwd = ctx.project.path
  if (ctx.git) {
    const wt = await createTaskWorktree({
      projectPath: ctx.project.path,
      worktreesDir: ctx.deps.paths.worktreesDir,
      projectName: ctx.project.name,
      taskId: ctx.task.id,
      taskText: ctx.task.text,
      baseBranch: ctx.baseBranch as string
    })
    ctx.worktreePath = wt.worktreePath
    ctx.branch = wt.branch
    cwd = wt.worktreePath
  }
  if (ctx.project.prepareCmd) {
    ctx.log.append(`[dispatch] prepare_cmd: ${ctx.project.prepareCmd}\n`)
    const r = await runShell(ctx.project.prepareCmd, { cwd, onLog: (c) => ctx.log.append(c) })
    if (r.exitCode !== 0) return failTask(ctx, 'prepare_failed')
  }
  const adapter = ctx.deps.adapterFor(ctx.task.agent as AgentId)
  try {
    await adapter.ensureReady()
  } catch (e) {
    return failTask(ctx, `agent_not_ready: ${(e as Error).message}`)
  }
  // W1b 分流:subAgent 非空 → 三段工作流编排;为空 → 既有单点路径(零语义变更)
  if (ctx.task.subAgent) return runWorkflow(ctx, adapter, cwd, WORKFLOW_HOST)
  const failReason = await runAgent(ctx, adapter, cwd)
  if (failReason) return failTask(ctx, failReason)
  return ctx.git ? mergeAndFinish(ctx) : finishNoVcs(ctx)
}

async function runAgent(
  ctx: ExecContext,
  adapter: AgentAdapter,
  cwd: string
): Promise<string | null> {
  const template = loadPromptTemplate(ctx.deps.paths.promptsDir, ctx.deps.builtinPromptFile)
  const prompt = renderPrompt(template, {
    TASK_TEXT: ctx.task.text,
    OUT_DIR: ctx.archiveDir,
    PROJECT_PATH: ctx.project.path,
    BASE_BRANCH: ctx.baseBranch ?? ''
  })
  const timeoutMs = ctx.deps.taskTimeoutMs ?? ctx.deps.config.task_timeout_min * 60_000
  const { timedOut, exitCode } = await runAdapterOnce(ctx, adapter, cwd, prompt, timeoutMs)
  if (timedOut) return 'timeout'
  if (exitCode !== 0) return `exit_${exitCode}`
  return judgeArtifacts(ctx.archiveDir)
}

/** 单次 adapter 运行:独立 AbortController + 超时,kill 统一由 adapter 经 platform.killTree 落实 */
async function runAdapterOnce(
  ctx: ExecContext,
  adapter: AgentAdapter,
  cwd: string,
  prompt: string,
  timeoutMs: number
): Promise<{ timedOut: boolean; exitCode: number }> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  let exitCode: number
  try {
    ;({ exitCode } = await adapter.run({
      prompt,
      cwd,
      outDir: ctx.archiveDir,
      timeoutMs,
      onLog: (c) => ctx.log.append(c),
      signal: controller.signal
    }))
  } finally {
    clearTimeout(timer)
  }
  return { timedOut, exitCode }
}

/** spec §6.3 完成判定,fail_reason 精确到缺哪环;工作流按阶段分用下方两个判定件 */
function judgeArtifacts(archiveDir: string): string | null {
  return judgePlanArtifact(archiveDir) ?? judgeResultArtifact(archiveDir)
}

function judgePlanArtifact(archiveDir: string): string | null {
  return existsSync(join(archiveDir, 'plan.md')) ? null : 'no_plan'
}

function judgeResultArtifact(archiveDir: string): string | null {
  const resultFile = join(archiveDir, 'result.json')
  if (!existsSync(resultFile)) return 'no_result'
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(resultFile, 'utf-8'))
  } catch {
    return 'bad_result'
  }
  if (!isTaskResult(parsed)) return 'bad_result'
  if (parsed.status === 'failed') return 'result_failed'
  return null
}

/** 工作流编排对单点基础设施的复用面:host 注入避免 index ↔ workflow 运行时循环依赖 */
const WORKFLOW_HOST: WorkflowHost = {
  runAdapterOnce,
  judgePlan: judgePlanArtifact,
  judgeResult: judgeResultArtifact,
  failTask,
  mergeAndFinish,
  finishNoVcs
}

function isTaskResult(v: unknown): v is TaskResult {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r.summary === 'string' &&
    (r.status === 'success' || r.status === 'partial' || r.status === 'failed')
  )
}

async function mergeAndFinish(ctx: ExecContext): Promise<Task> {
  ctx.deps.tasks.transition(ctx.task.id, 'merging', {
    archiveDir: ctx.archiveDir,
    worktreePath: ctx.worktreePath,
    branch: ctx.branch
  })
  const o = {
    projectPath: ctx.project.path,
    worktreePath: ctx.worktreePath as string,
    baseBranch: ctx.baseBranch as string,
    branch: ctx.branch as string
  }
  const outcome = await ctx.deps.mergeLocks.withLock(ctx.project.id, () => mergeFlow(o))
  const finishedAt = ctx.now().toISOString()
  if (outcome.kind === 'merged') {
    await removeWorktree(o.projectPath, o.worktreePath, o.branch)
    return ctx.deps.tasks.transition(ctx.task.id, 'done', {
      finishedAt,
      mergedAt: finishedAt,
      worktreePath: null
    })
  }
  if (outcome.kind === 'conflict') {
    await writeConflictReport({ archiveDir: ctx.archiveDir, ...o, files: outcome.files })
    return ctx.deps.tasks.transition(ctx.task.id, 'conflict', { finishedAt })
  }
  return ctx.deps.tasks.transition(ctx.task.id, 'awaiting_merge', {
    finishedAt,
    failReason: outcome.reason
  })
}

function finishNoVcs(ctx: ExecContext): Task {
  return ctx.deps.tasks.transition(ctx.task.id, 'done', {
    archiveDir: ctx.archiveDir,
    finishedAt: ctx.now().toISOString()
  })
}

/**
 * B3 追加:重试合并入口。起点 awaiting_merge(调度器自动 / 用户手动)或
 * conflict(仅手动,用户在 worktree 解决并提交后触发)。不占执行信号量,只持项目合并锁。
 */
export async function retryMerge(deps: ExecutorDeps, taskId: string): Promise<Task> {
  const task = deps.tasks.get(taskId)
  if (!task) throw new Error(`任务不存在: ${taskId}`)
  if (task.status !== 'awaiting_merge' && task.status !== 'conflict') {
    throw new Error(`任务 ${taskId} 状态 ${task.status} 不可重试合并`)
  }
  const project = deps.projects.get(task.projectId)
  if (!project) throw new Error(`任务 ${taskId} 关联项目不存在: ${task.projectId}`)
  const now = deps.now ?? (() => new Date())
  // 恢复场景回填缺失(或 worktree 目录已被删)→ 无从合并,落定 failed
  if (
    !task.worktreePath ||
    !task.branch ||
    !task.baseBranch ||
    !existsSync(task.worktreePath)
  ) {
    return deps.tasks.transition(task.id, 'failed', {
      failReason: 'worktree_missing',
      finishedAt: now().toISOString()
    })
  }
  const o = {
    projectPath: project.path,
    worktreePath: task.worktreePath,
    baseBranch: task.baseBranch,
    branch: task.branch
  }
  deps.tasks.transition(task.id, 'merging', { failReason: null })
  try {
    const outcome = await deps.mergeLocks.withLock(project.id, () => mergeFlow(o))
    if (outcome.kind === 'merged') {
      await removeWorktree(o.projectPath, o.worktreePath, o.branch)
      return deps.tasks.transition(task.id, 'done', {
        mergedAt: now().toISOString(),
        worktreePath: null
      })
    }
    if (outcome.kind === 'conflict') {
      // archiveDir 仅在恢复未回填时缺失,此时无处落报告,状态仍如实置 conflict
      if (task.archiveDir) {
        await writeConflictReport({ archiveDir: task.archiveDir, ...o, files: outcome.files })
      }
      return deps.tasks.transition(task.id, 'conflict')
    }
    return deps.tasks.transition(task.id, 'awaiting_merge', { failReason: outcome.reason })
  } catch (e) {
    // 非预期 git 错误(如用户 worktree 中 merge 未收尾):宁可误停,worktree 保留供排查
    return deps.tasks.transition(task.id, 'failed', {
      failReason: `merge_retry: ${(e as Error).message}`,
      finishedAt: now().toISOString()
    })
  }
}

function failTask(ctx: ExecContext, failReason: string): Task {
  ctx.log.append(`[dispatch] 任务失败: ${failReason}\n`)
  return ctx.deps.tasks.transition(ctx.task.id, 'failed', {
    failReason,
    finishedAt: ctx.now().toISOString(),
    archiveDir: ctx.archiveDir,
    worktreePath: ctx.worktreePath,
    branch: ctx.branch
  })
}

/** 兜底:running/merging 中未预期异常一律转任务失败,不吞错也不留悬挂状态 */
function failCurrent(ctx: ExecContext, e: Error): Task {
  const current = ctx.deps.tasks.get(ctx.task.id)
  if (!current || (current.status !== 'running' && current.status !== 'merging')) throw e
  return failTask(ctx, `internal: ${e.message}`)
}

export { Semaphore, KeyedLock } from './locks'
