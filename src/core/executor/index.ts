import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { AgentId, Project, Task, TaskPhase } from '@shared/types'
import type { DispatchConfig } from '@core/config'
import type { DispatchPaths } from '@core/paths'
import type { ProjectStore, TaskStore } from '@core/db'
import type { AgentAdapter, TaskResult } from '@core/agents/types'
import { createArchive, OutputLog } from '@core/archive'
import { supportsSession } from '@core/agents/session'
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
import type { KeyedLock, Semaphore, TaskCancellations } from './locks'
import { runWorkflow, type WorkflowHost } from './workflow'

export interface ExecutorDeps {
  tasks: TaskStore
  projects: ProjectStore
  config: DispatchConfig
  paths: DispatchPaths
  adapterFor: (agent: AgentId) => AgentAdapter
  semaphore: Semaphore
  mergeLocks: KeyedLock
  /** 用户中断登记表(缺省不可中断);面板会话不经此表,由 SessionService 自管 */
  cancellations?: TaskCancellations
  /** 测试注入假时钟;缺省真实时钟 */
  now?: () => Date
  /**
   * 应用内置模板路径(单文件形态,指向 default.md),shell 层传入;缺省走 prompt 模块兜底。
   * 方案确认闸上线后 default.md 已被 default-plan.md/default-exec.md 取代,执行器不再消费本字段;
   * 保留仅为维持 builtinPromptFile === join(builtinPromptsDir, 'default.md') 的装配约定与兼容位。
   */
  builtinPromptFile?: string
  /**
   * W1b 追加:内置模板目录,工作流路径按 wf-<phase>.md 从中解析;方案确认闸起单点两跑的
   * default-plan.md/default-exec.md 也从中按文件名解析(与 wf-*.md 同一路径约定)。
   * shell 层与 builtinPromptFile 都传时必须指向同一份内置资源目录。
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

export interface GitInfo {
  git: boolean
  baseBranch: string | null
  error: string | null
}

/**
 * 状态检查之外不抛错:错误延迟到 running 后转任务失败(scheduled→failed 非法迁移)。
 * 导出供 follow-up 会话引擎复用(与 mergeAndFinish/finishNoVcs/failTask 同属复用面)。
 */
export async function detectGitInfo(project: Project): Promise<GitInfo> {
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
  // 方案确认闸恢复分支:确认后重入(scheduled 但 phase 冻结为 plan 且已有归档)→ 复用暂停时字段跳过方案跑。
  // plan.md 已被用户删除时无从执行,回退完整首跑(下方 confirmedRerun 日志说明)。
  const confirmedRerun = task.phase === 'plan' && task.archiveDir !== null
  if (confirmedRerun && existsSync(join(task.archiveDir as string, 'plan.md'))) {
    return resumeAfterConfirm(deps, task, project, now)
  }
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
    if (confirmedRerun) {
      ctx.log.append(
        `[dispatch] 确认重入但归档 plan.md 已缺失,回退完整首跑(原归档: ${task.archiveDir})\n`
      )
    }
    if (info.error) return failTask(ctx, info.error)
    return await runPhases(ctx)
  } catch (e) {
    return failCurrent(ctx, e as Error)
  } finally {
    await ctx.log.close()
  }
}

/**
 * 用户确认后重入执行:复用 running→awaiting_confirm 暂停时持久化的归档/worktree/base,
 * 不跑 detectGitInfo(沿用 task.baseBranch,避免主工作区分支切换污染合并目标)、
 * 不跑 createArchive(复用 task.archiveDir,firstFreeDir 会另开 -N 目录丢失 plan.md 上下文)。
 * git 与否以 task.worktreePath 是否非空判定(首跑 git 项目已建 worktree)。
 */
async function resumeAfterConfirm(
  deps: ExecutorDeps,
  task: Task,
  project: Project,
  now: () => Date
): Promise<Task> {
  const running = deps.tasks.transition(task.id, 'running', {})
  const archiveDir = running.archiveDir as string
  const ctx: ExecContext = {
    deps,
    task: running,
    project,
    git: running.worktreePath !== null,
    baseBranch: running.baseBranch,
    archiveDir,
    log: new OutputLog(archiveDir),
    worktreePath: running.worktreePath,
    branch: running.branch,
    now
  }
  try {
    ctx.log.append('[dispatch] 用户已确认方案,重入执行(跳过方案阶段)\n')
    return await runPhases(ctx, true)
  } catch (e) {
    return failCurrent(ctx, e as Error)
  } finally {
    await ctx.log.close()
  }
}

async function runPhases(ctx: ExecContext, resume = false): Promise<Task> {
  let cwd = ctx.project.path
  if (ctx.git) {
    if (resume) {
      // 复用首跑 worktree(ctx.worktreePath/branch 已由 resumeAfterConfirm 从任务字段填入)
      cwd = ctx.worktreePath as string
    } else {
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
  }
  // 重入跳过 prepare_cmd(首跑已装);首跑照旧
  if (!resume && ctx.project.prepareCmd) {
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
  // W1b 分流:subAgent 非空 → 三段工作流编排(runWorkflow 内部按重入标记自行跳过 plan);为空 → 单点路径
  if (ctx.task.subAgent) return runWorkflow(ctx, adapter, cwd, WORKFLOW_HOST)
  // 单点两跑:重入 → 执行跑(default-exec.md);首跑 → 方案跑(default-plan.md)后暂停或连跑
  return resume ? runExecPhase(ctx, adapter, cwd) : runPlanPhaseSingle(ctx, adapter, cwd)
}

/**
 * fresh run 前为支持会话的 agent 预生成会话 id 并落库(--session-id 可寻址,追问的前提)。
 * 会话能力以 deps.config.agents 为唯一判定源(生产环境 adapter 由同一配置构建);
 * 工作流 plan/review 各自调用,后写覆盖(last-wins),任务留最后一次主 agent 会话。
 */
function prepareSessionId(ctx: ExecContext, agentId: AgentId): string | undefined {
  const agentConfig = ctx.deps.config.agents[agentId]
  if (!agentConfig || !supportsSession(agentConfig)) return undefined
  const sessionId = randomUUID()
  ctx.deps.tasks.setSessionId(ctx.task.id, sessionId)
  return sessionId
}

/**
 * 单点两跑共用的主 agent 单次运行:按文件名从 builtinPromptsDir 解析模板(与 wf-*.md 同路径约定),
 * 渲染四变量、预生成会话 id、跑一次 adapter。返回 fail_reason(进程级失败)或 null(进程正常退出);
 * 产物判定由调用方按阶段(方案跑判 plan.md、执行跑判 result.json)各自完成。
 */
async function runMainAgentOnce(
  ctx: ExecContext,
  adapter: AgentAdapter,
  cwd: string,
  fileName: string
): Promise<string | null> {
  const builtin = ctx.deps.builtinPromptsDir
    ? join(ctx.deps.builtinPromptsDir, fileName)
    : undefined
  const template = loadPromptTemplate(ctx.deps.paths.promptsDir, builtin, fileName)
  const prompt = renderPrompt(template, {
    TASK_TEXT: ctx.task.text,
    OUT_DIR: ctx.archiveDir,
    PROJECT_PATH: ctx.project.path,
    BASE_BRANCH: ctx.baseBranch ?? ''
  })
  const timeoutMs = ctx.deps.taskTimeoutMs ?? ctx.deps.config.task_timeout_min * 60_000
  const sessionId = prepareSessionId(ctx, ctx.task.agent as AgentId)
  const { timedOut, exitCode, interrupted } = await runAdapterOnce(
    ctx,
    adapter,
    cwd,
    prompt,
    timeoutMs,
    sessionId
  )
  if (interrupted) return 'user_interrupted'
  if (timedOut) return 'timeout'
  if (exitCode !== 0) return `exit_${exitCode}`
  return null
}

/**
 * 单点首跑=方案跑:渲染 default-plan.md、setPhase('plan')、跑主 agent 判 plan.md。
 * 判过后:result.json 也已存在(用户改回连跑模板)→ 按旧语义判定后走合并/no_vcs 收尾(连跑兼容分支);
 * 否则暂停 running→awaiting_confirm(TransitionPatch 带归档/worktree/branch,phase 冻结为 plan),
 * 直接返回——执行信号量由 runTask 的 finally 自动释放,不额外操作。
 */
async function runPlanPhaseSingle(
  ctx: ExecContext,
  adapter: AgentAdapter,
  cwd: string
): Promise<Task> {
  ctx.deps.tasks.setPhase(ctx.task.id, 'plan')
  const fail = await runMainAgentOnce(ctx, adapter, cwd, 'default-plan.md')
  if (fail) return failTask(ctx, fail)
  const planFail = judgePlanArtifact(ctx.archiveDir)
  if (planFail) return failTask(ctx, planFail)
  if (existsSync(join(ctx.archiveDir, 'result.json'))) {
    const resultFail = judgeResultArtifact(ctx.archiveDir)
    if (resultFail) return failTask(ctx, resultFail)
    ctx.deps.tasks.setPhase(ctx.task.id, null)
    return ctx.git ? mergeAndFinish(ctx) : finishNoVcs(ctx)
  }
  ctx.log.append('[dispatch] 方案已产出,暂停等待用户确认(awaiting_confirm)\n')
  return ctx.deps.tasks.transition(ctx.task.id, 'awaiting_confirm', {
    archiveDir: ctx.archiveDir,
    worktreePath: ctx.worktreePath,
    branch: ctx.branch
  })
}

/**
 * 单点执行跑(确认后重入):渲染 default-exec.md、setPhase('implement')、跑主 agent 判产物;
 * 成功后离开 running 前 setPhase(null) 清场(与 workflow 既有纪律一致),再走合并/no_vcs 收尾。
 */
async function runExecPhase(
  ctx: ExecContext,
  adapter: AgentAdapter,
  cwd: string
): Promise<Task> {
  ctx.deps.tasks.setPhase(ctx.task.id, 'implement')
  const fail = await runMainAgentOnce(ctx, adapter, cwd, 'default-exec.md')
  if (fail) return failTask(ctx, fail)
  const artifactFail = judgeArtifacts(ctx.archiveDir)
  if (artifactFail) return failTask(ctx, artifactFail)
  ctx.deps.tasks.setPhase(ctx.task.id, null)
  return ctx.git ? mergeAndFinish(ctx) : finishNoVcs(ctx)
}

/**
 * 单次 adapter 运行:独立 AbortController + 超时,kill 统一由 adapter 经 platform.killTree 落实;
 * 运行期间在中断登记表挂号,用户中断与超时/普通失败在返回值区分。
 */
async function runAdapterOnce(
  ctx: ExecContext,
  adapter: AgentAdapter,
  cwd: string,
  prompt: string,
  timeoutMs: number,
  sessionId?: string
): Promise<{ timedOut: boolean; exitCode: number; interrupted: boolean }> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  ctx.deps.cancellations?.register(ctx.task.id, controller)
  let exitCode: number
  try {
    ;({ exitCode } = await adapter.run({
      prompt,
      cwd,
      outDir: ctx.archiveDir,
      timeoutMs,
      onLog: (c) => ctx.log.append(c),
      signal: controller.signal,
      sessionId
    }))
  } finally {
    clearTimeout(timer)
    ctx.deps.cancellations?.unregister(ctx.task.id)
  }
  const interrupted = ctx.deps.cancellations?.consumeInterrupted(ctx.task.id) ?? false
  return { timedOut, exitCode, interrupted }
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
  prepareSessionId,
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

/** 导出供 follow-up 会话引擎复用(follow-up.ts 不被本文件引用,无运行时循环) */
export async function mergeAndFinish(ctx: ExecContext): Promise<Task> {
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

export function finishNoVcs(ctx: ExecContext): Task {
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

/**
 * 方案确认闸:用户确认方案后放行执行。守卫 awaiting_confirm → 先关讨论会话(closeDiscussion 幂等,
 * 开着才实际关)→ transition awaiting_confirm→scheduled(暂停时持久化的 phase='plan'/archiveDir/worktree
 * 经空 patch 保留,供 execute() 的恢复分支重入跳过方案阶段)。
 *
 * 关会话必须先于迁移:讨论进行中确认时,先杀讨论传输再放行执行,避免同一 worktree 里讨论进程与执行进程并存。
 * 入队(fire-and-forget runTask)由壳层在迁移后完成,不在本函数内——core 层不承担进程编排与其错误日志。
 * closeDiscussion 由壳层注入(讨论会话表归 SessionService),core 层不触 Electron。
 */
export function confirmPlan(
  deps: ExecutorDeps,
  taskId: string,
  closeDiscussion: (taskId: string) => void
): Task {
  const task = deps.tasks.get(taskId)
  if (!task) throw new Error(`任务不存在: ${taskId}`)
  if (task.status !== 'awaiting_confirm') {
    throw new Error(`任务 ${taskId} 状态 ${task.status} 不可确认(仅 awaiting_confirm)`)
  }
  closeDiscussion(taskId)
  return deps.tasks.transition(taskId, 'scheduled', {})
}

export function failTask(ctx: ExecContext, failReason: string): Task {
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
