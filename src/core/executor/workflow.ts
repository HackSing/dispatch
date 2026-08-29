import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentId, Task, TaskPhase } from '@shared/types'
import type { AgentAdapter } from '@core/agents/types'
import { loadPromptTemplate, renderPrompt } from '@core/prompt'
import { headSha, statusPorcelain } from '@core/gitops'
import type { ExecContext } from './index'

/**
 * 审查打回返工上限(Plan workflow-stage1 冻结决策:返工上限 2 轮)。
 * 第 r 轮审查 reject 时:r ≤ 上限 → 归档留痕后打回返工;r > 上限 → failed: review_rejected。
 * 即最多发生 3 轮审查(首轮 + 2 轮返工),连续 reject×3 整单失败。
 */
const MAX_REWORK_ROUNDS = 2

/**
 * 工作流编排对单点基础设施的复用面,由 index.ts 注入(host 注入避免运行时循环依赖):
 * 单次 adapter 运行、plan/result 完成判定、失败落定、合并链路与 no_vcs 收尾全部复用既有实现。
 */
export interface WorkflowHost {
  runAdapterOnce(
    ctx: ExecContext,
    adapter: AgentAdapter,
    cwd: string,
    prompt: string,
    timeoutMs: number,
    sessionId?: string
  ): Promise<{ timedOut: boolean; exitCode: number; interrupted: boolean }>
  /** 主 agent fresh run 前预生成会话 id 并落库;不支持会话的 agent 返回 undefined */
  prepareSessionId(ctx: ExecContext, agentId: AgentId): string | undefined
  judgePlan(archiveDir: string): string | null
  judgeResult(archiveDir: string): string | null
  failTask(ctx: ExecContext, failReason: string): Task
  mergeAndFinish(ctx: ExecContext): Promise<Task>
  finishNoVcs(ctx: ExecContext): Task
}

/** review-r<round>.json 的结构化判定(wf-review §4 schema),边界校验后下游直接信任 */
interface ReviewIssue {
  severity?: string
  desc?: string
  suggestion?: string
}

interface ReviewReport {
  verdict: 'pass' | 'reject'
  summary?: string
  issues?: ReviewIssue[]
}

type ReviewOutcome = { fail: string; report?: undefined } | { fail?: undefined; report: ReviewReport }

/** 审查前后 worktree 快照:HEAD sha + status --porcelain 原文,任一变化即审查越权修改 */
interface WorktreeSnapshot {
  head: string
  status: string
}

/**
 * W1b 工作流三段编排:plan(主)→ implement(子,可返工)→ review(主)→ pass 合并 / reject 打回。
 * 前置:Phase0(running 迁移、归档、worktree、prepare、主 adapter ensureReady)已由 index.ts 完成。
 *
 * 失败语义:任何 failed 迁移前都不清 phase——phase 保留为「死在哪个阶段」的追溯现场
 * (setPhase 仅 running 态可调,失败迁移后该字段随任务冻结);只有 verdict=pass
 * 离开 running 进入合并链路前才 setPhase(null) 清场。
 */
export async function runWorkflow(
  ctx: ExecContext,
  mainAdapter: AgentAdapter,
  cwd: string,
  host: WorkflowHost
): Promise<Task> {
  // 方案确认闸重入标记:确认后任务 phase 冻结为 plan 且 plan.md 已落归档 → 跳过 runPlanPhase 与其判定,
  // 直接进入 implement 循环(方案已由用户确认,不再重跑方案阶段)。首跑 phase 为 null,照常跑方案阶段。
  const resuming = ctx.task.phase === 'plan' && existsSync(join(ctx.archiveDir, 'plan.md'))
  if (!resuming) {
    const planFail = await runPlanPhase(ctx, mainAdapter, cwd, host)
    if (planFail) return host.failTask(ctx, planFail)
    // 方案确认闸:工作流首跑方案判过后同样暂停等待用户确认(与单点 runPlanPhaseSingle 完全对齐)。
    // phase 已由 runPlanPhase 冻结为 'plan';确认重入时上方 resuming 命中,跳过本段直入 implement。
    // 工作流方案跑只产 plan.md(implement 才产 result.json),故无单点的 result.json 连跑兼容分支。
    ctx.log.append('[dispatch] 方案已产出,暂停等待用户确认(awaiting_confirm)\n')
    return ctx.deps.tasks.transition(ctx.task.id, 'awaiting_confirm', {
      archiveDir: ctx.archiveDir,
      worktreePath: ctx.worktreePath,
      branch: ctx.branch
    })
  }

  // 子 adapter 的 ensureReady 推迟到 implement 阶段首次运行前(主 adapter 已在 Phase0 就绪)
  const subAdapter = ctx.deps.adapterFor(ctx.task.subAgent as AgentId)
  try {
    await subAdapter.ensureReady()
  } catch (e) {
    return host.failTask(ctx, `agent_not_ready: ${(e as Error).message}`)
  }

  // wf-implement §3:REVIEW_FEEDBACK 首轮注入「无」,返工轮注入上轮审查 issues 序列化文本
  let feedback = '无'
  for (let round = 1; ; round++) {
    const implFail = await runImplementPhase(ctx, subAdapter, cwd, host, round, feedback)
    if (implFail) return host.failTask(ctx, implFail)
    const review = await runReviewPhase(ctx, mainAdapter, cwd, host, round)
    if (review.fail !== undefined) return host.failTask(ctx, review.fail)
    if (review.report.verdict === 'pass') break
    if (round > MAX_REWORK_ROUNDS) return host.failTask(ctx, 'review_rejected')
    // 留痕:本轮实现产物复制为 result-r<round>.json,原名留给下轮覆盖(wf-implement 承诺的产物名不变)
    copyFileSync(join(ctx.archiveDir, 'result.json'), join(ctx.archiveDir, `result-r${round}.json`))
    feedback = serializeReviewFeedback(round, review.report)
  }

  // pass:离开 running 前清 phase,随后复用与单点完全相同的合并链路 / no_vcs 收尾
  ctx.deps.tasks.setPhase(ctx.task.id, null)
  return ctx.git ? host.mergeAndFinish(ctx) : host.finishNoVcs(ctx)
}

/** wf-plan:主 adapter 产出 {OUT_DIR}/plan.md;缺 → no_plan,超时 → timeout_plan */
async function runPlanPhase(
  ctx: ExecContext,
  adapter: AgentAdapter,
  cwd: string,
  host: WorkflowHost
): Promise<string | null> {
  ctx.log.append('\n===== phase: plan =====\n')
  ctx.deps.tasks.setPhase(ctx.task.id, 'plan')
  const prompt = renderPrompt(wfTemplate(ctx, 'plan'), baseVars(ctx))
  const sessionId = host.prepareSessionId(ctx, ctx.task.agent as AgentId)
  const { timedOut, exitCode, interrupted } = await host.runAdapterOnce(
    ctx,
    adapter,
    cwd,
    prompt,
    phaseTimeoutMs(ctx, 'plan'),
    sessionId
  )
  if (interrupted) return 'user_interrupted'
  if (timedOut) return 'timeout_plan'
  if (exitCode !== 0) return `exit_${exitCode}`
  return host.judgePlan(ctx.archiveDir)
}

/**
 * wf-implement:子 adapter 按 plan.md 实现并产出 {OUT_DIR}/result.json;
 * 缺/坏/failed → no_result/bad_result/result_failed,超时 → timeout_implement。
 */
async function runImplementPhase(
  ctx: ExecContext,
  adapter: AgentAdapter,
  cwd: string,
  host: WorkflowHost,
  round: number,
  feedback: string
): Promise<string | null> {
  ctx.log.append(`\n===== phase: implement round ${round} =====\n`)
  // reviewRound 记录已完成的审查轮数:首轮实现为 0,第 r 轮(返工)实现为 r-1
  ctx.deps.tasks.setPhase(ctx.task.id, 'implement', round - 1)
  const prompt = renderPrompt(wfTemplate(ctx, 'implement'), {
    ...baseVars(ctx),
    REVIEW_FEEDBACK: feedback
  })
  const { timedOut, exitCode, interrupted } = await host.runAdapterOnce(
    ctx,
    adapter,
    cwd,
    prompt,
    phaseTimeoutMs(ctx, 'implement')
  )
  if (interrupted) return 'user_interrupted'
  if (timedOut) return 'timeout_implement'
  if (exitCode !== 0) return `exit_${exitCode}`
  return host.judgeResult(ctx.archiveDir)
}

/**
 * wf-review:主 adapter 只评不改,产出 {OUT_DIR}/review-r<round>.json。
 * 审查前快照 worktree(git:HEAD sha + status --porcelain;非 git:跳过修改检测并在日志注明),
 * 审查后对比,任何改动 → review_modified(优先于退出码与产物判定,越权即整单失败);
 * 缺 → no_review,坏 JSON/形状不符/verdict 非 pass|reject → bad_review,超时 → timeout_review。
 */
async function runReviewPhase(
  ctx: ExecContext,
  adapter: AgentAdapter,
  cwd: string,
  host: WorkflowHost,
  round: number
): Promise<ReviewOutcome> {
  ctx.log.append(`\n===== phase: review round ${round} =====\n`)
  const before = ctx.git ? await snapshotWorktree(cwd) : null
  if (!before) ctx.log.append('[dispatch] 非 git 项目:跳过审查越权修改检测\n')
  ctx.deps.tasks.setPhase(ctx.task.id, 'review', round)
  const prompt = renderPrompt(wfTemplate(ctx, 'review'), {
    ...baseVars(ctx),
    REVIEW_ROUND: String(round)
  })
  // 主 agent 每次 fresh run 各自生成会话,后写覆盖:任务最终留最后一次审查会话(v03 冻结)
  const sessionId = host.prepareSessionId(ctx, ctx.task.agent as AgentId)
  const { timedOut, exitCode, interrupted } = await host.runAdapterOnce(
    ctx,
    adapter,
    cwd,
    prompt,
    phaseTimeoutMs(ctx, 'review'),
    sessionId
  )
  if (interrupted) return { fail: 'user_interrupted' }
  if (timedOut) return { fail: 'timeout_review' }
  if (before) {
    const after = await snapshotWorktree(cwd)
    if (after.head !== before.head || after.status !== before.status) {
      return { fail: 'review_modified' }
    }
  }
  if (exitCode !== 0) return { fail: `exit_${exitCode}` }
  return judgeReviewArtifact(ctx.archiveDir, round)
}

/** wf 模板固定命名 wf-<phase>.md;builtinPromptsDir 未接线且用户模板缺失时由 loadPromptTemplate 明确报错 */
function wfTemplate(ctx: ExecContext, phase: TaskPhase): string {
  const fileName = `wf-${phase}.md`
  const builtin = ctx.deps.builtinPromptsDir ? join(ctx.deps.builtinPromptsDir, fileName) : undefined
  return loadPromptTemplate(ctx.deps.paths.promptsDir, builtin, fileName)
}

function baseVars(ctx: ExecContext): {
  TASK_TEXT: string
  OUT_DIR: string
  PROJECT_PATH: string
  BASE_BRANCH: string
} {
  return {
    TASK_TEXT: ctx.task.text,
    OUT_DIR: ctx.archiveDir,
    PROJECT_PATH: ctx.project.path,
    BASE_BRANCH: ctx.baseBranch ?? ''
  }
}

function phaseTimeoutMs(ctx: ExecContext, phase: TaskPhase): number {
  return (
    ctx.deps.workflowPhaseTimeoutsMs?.[phase] ??
    ctx.deps.config.workflow_phase_timeout_min[phase] * 60_000
  )
}

async function snapshotWorktree(cwd: string): Promise<WorktreeSnapshot> {
  return { head: await headSha(cwd), status: await statusPorcelain(cwd) }
}

function judgeReviewArtifact(archiveDir: string, round: number): ReviewOutcome {
  const file = join(archiveDir, `review-r${round}.json`)
  if (!existsSync(file)) return { fail: 'no_review' }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    return { fail: 'bad_review' }
  }
  if (!isReviewReport(parsed)) return { fail: 'bad_review' }
  return { report: parsed }
}

function isReviewReport(v: unknown): v is ReviewReport {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  if (r.verdict !== 'pass' && r.verdict !== 'reject') return false
  if (r.issues === undefined) return true
  return (
    Array.isArray(r.issues) && r.issues.every((i) => typeof i === 'object' && i !== null)
  )
}

/** wf-implement §3 的 {REVIEW_FEEDBACK} 注入体:上轮审查结论 + issues 序列化为编号清单 */
function serializeReviewFeedback(round: number, report: ReviewReport): string {
  const lines = [`第 ${round} 轮审查结论:reject`]
  if (report.summary) lines.push(`审查摘要:${report.summary}`)
  const issues = report.issues ?? []
  issues.forEach((issue, i) => {
    lines.push(`${i + 1}. [${issue.severity ?? 'unspecified'}] ${issue.desc ?? '(未填写问题描述)'}`)
    if (issue.suggestion) lines.push(`   修改指令:${issue.suggestion}`)
  })
  if (issues.length === 0) lines.push('(审查未列出具体 issues,请依据审查摘要修正)')
  return lines.join('\n')
}
