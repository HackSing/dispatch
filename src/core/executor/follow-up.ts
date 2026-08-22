/**
 * 会话面板引擎(Plan interaction-batch-v03):一次面板会话 = 一条接力任务、
 * 一个 worktree、一个传输、N 轮对话、结束一次合并。
 * 状态机零新增边:todo→scheduled→running 同步走完(trigger=none 对调度器不可见),
 * 会话全程 running;finish 复用 mergeAndFinish/finishNoVcs,abandon/异常复用 failTask。
 * 并发决策(v03 冻结):不占执行信号量(在场工作不排队),合并仍持项目合并锁。
 */

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentId, Task } from '@shared/types'
import type { AgentConfig } from '@core/config'
import { createArchive, OutputLog } from '@core/archive'
import { followUpTransport } from '@core/agents/session'
import {
  RoundSpawnTransport,
  RoundTimeoutError,
  SessionExitError,
  StreamTransport,
  type RoundResult,
  type SessionTransport
} from '@core/agents/session-transport'
import { getPlatformOps } from '@core/platform'
import { loadPromptTemplate, renderPrompt } from '@core/prompt'
import { createTaskWorktree } from '@core/gitops'
import { runShell } from '@core/proc/shell'
import { shortId } from '@core/naming'
import { cleanupTaskWorkspace } from './cleanup'
import {
  detectGitInfo,
  failTask,
  finishNoVcs,
  mergeAndFinish,
  type ExecContext,
  type ExecutorDeps
} from './index'

export type SessionCloseReason = 'finished' | 'abandoned' | 'failed'

export interface FollowUpEvents {
  onRoundStart(task: Task, round: number): void
  onChunk(taskId: string, text: string): void
  onRoundResult(task: Task, round: number, result: RoundResult): void
  onClosed(task: Task, reason: SessionCloseReason): void
}

type SessionState = 'open' | 'closed'

/** 接力任务文本(v03 冻结形态);列表/详情借 parentTaskId 展示链路 */
function followUpText(parentId: string): string {
  return `[会话] 接力自 ${shortId(parentId)}`
}

export class FollowUpSession {
  private state: SessionState = 'open'
  private round = 0
  private roundInFlight = false

  private constructor(
    private readonly ctx: ExecContext,
    private readonly transport: SessionTransport,
    private readonly events: FollowUpEvents,
    private readonly cwd: string
  ) {}

  get taskId(): string {
    return this.ctx.task.id
  }

  /** 会话工作目录(git 项目为 worktree),终端逃生舱等入口复用 */
  get workingDir(): string {
    return this.cwd
  }

  get open(): boolean {
    return this.state === 'open'
  }

  /** 本轮进行中(输入闸门:UI 与壳层同步校验用) */
  get busy(): boolean {
    return this.roundInFlight
  }

  /**
   * 开启面板会话:守卫 → 建接力任务 → 同步推进 running → 归档/worktree/prepare →
   * 传输就绪。守卫失败在建任务前抛错;此后的失败落 failed 终态再抛错(任务可见可清理)。
   */
  static async start(
    deps: ExecutorDeps,
    parentId: string,
    events: FollowUpEvents
  ): Promise<FollowUpSession> {
    const parent = deps.tasks.get(parentId)
    if (!parent) throw new Error(`任务不存在: ${parentId}`)
    if (parent.status !== 'done' && parent.status !== 'failed') {
      throw new Error(`任务状态 ${parent.status} 不可继续对话(仅 done/failed)`)
    }
    if (!parent.sessionId) throw new Error('该任务没有可续接的会话(执行时未记录 session id)')
    if (!parent.agent) throw new Error('该任务没有 agent,无从续会话')
    const agentConfig = deps.config.agents[parent.agent]
    const kind = agentConfig ? followUpTransport(agentConfig) : null
    if (!agentConfig || !kind) {
      throw new Error(`agent ${parent.agent} 未配置会话续接能力(resume_stream/headless_args)`)
    }

    const project = deps.projects.get(parent.projectId)
    if (!project) throw new Error(`任务关联项目不存在: ${parent.projectId}`)
    const now = deps.now ?? (() => new Date())
    const info = await detectGitInfo(project)

    const created = deps.tasks.create({
      text: followUpText(parent.id),
      projectId: parent.projectId,
      agent: parent.agent,
      subAgent: null,
      triggerType: 'none',
      sessionId: parent.sessionId,
      parentTaskId: parent.id
    })
    // trigger=none 对调度器不可见(isDue 恒 false),两步迁移间无入队竞态
    deps.tasks.transition(created.id, 'scheduled', { scheduledAt: now().toISOString() })
    const running = deps.tasks.transition(created.id, 'running', {
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
      // 与批量链路同语义:git 探测错误延迟到 running 后落定,failReason 词表一致
      if (info.error) throw new Error(info.error)
      return await FollowUpSession.setup(ctx, parent, agentConfig, kind, events)
    } catch (e) {
      const failed = failTask(ctx, (e as Error).message)
      await ctx.log.close()
      events.onClosed(failed, 'failed')
      throw e
    }
  }

  private static async setup(
    ctx: ExecContext,
    parent: Task,
    agentConfig: AgentConfig,
    kind: 'stream' | 'round',
    events: FollowUpEvents
  ): Promise<FollowUpSession> {
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
      if (r.exitCode !== 0) throw new Error('prepare_failed')
    }
    const adapter = ctx.deps.adapterFor(ctx.task.agent as AgentId)
    try {
      await adapter.ensureReady()
    } catch (e) {
      throw new Error(`agent_not_ready: ${(e as Error).message}`)
    }

    const sessionId = parent.sessionId as string
    const onChunk = (text: string): void => {
      ctx.log.append(text)
      events.onChunk(ctx.task.id, text)
    }
    // 空闲期进程意外退出的回调先于 session 构造注册,经 ref 间接指向(构造完成前的
    // 微秒级窗口内退出会延迟到首次 sendTurn 以传输错误暴露,不丢失终态)
    const sessionRef: { current: FollowUpSession | null } = { current: null }
    const transport: SessionTransport =
      kind === 'stream'
        ? new StreamTransport({
            config: agentConfig,
            platform: getPlatformOps(),
            cwd,
            sessionId,
            onChunk,
            onUnexpectedExit: (code) =>
              void sessionRef.current?.failClose(`session_exit_${code ?? 'null'}`)
          })
        : new RoundSpawnTransport({
            adapter,
            cwd,
            outDir: ctx.archiveDir,
            sessionId,
            onChunk
          })
    await transport.open()
    const session = new FollowUpSession(ctx, transport, events, cwd)
    sessionRef.current = session
    return session
  }

  /** 逐轮送话:首轮经 follow-up.md 模板注入环境事实,后续轮原文直发 */
  async sendTurn(text: string): Promise<void> {
    if (!this.open) throw new Error('会话已关闭')
    if (this.roundInFlight) throw new Error('上一轮未结束,不可发送')
    const round = ++this.round
    const prompt = round === 1 ? this.renderFirstTurn(text) : text
    this.ctx.log.append(`\n===== round ${round} =====\n[user] ${text}\n`)
    this.events.onRoundStart(this.ctx.task, round)
    this.roundInFlight = true
    const timeoutMs =
      this.ctx.deps.taskTimeoutMs ?? this.ctx.deps.config.task_timeout_min * 60_000
    let result: RoundResult
    try {
      result = await this.transport.sendTurn(prompt, timeoutMs)
    } catch (e) {
      this.roundInFlight = false
      if (e instanceof RoundTimeoutError) {
        await this.failClose('timeout_round')
      } else if (e instanceof SessionExitError) {
        await this.failClose(`session_exit_${e.exitCode ?? 'null'}`)
      } else {
        await this.failClose(`round_error: ${(e as Error).message}`)
      }
      throw e
    }
    this.roundInFlight = false
    this.appendRoundRecord(round, text, result)
    this.events.onRoundResult(this.ctx.task, round, result)
  }

  /** 用户裁决完成:关传输后走与批量任务完全相同的合并链路 / no_vcs 收尾 */
  async finish(): Promise<Task> {
    this.assertIdle()
    this.state = 'closed'
    await this.transport.close()
    let task: Task
    try {
      task = this.ctx.git ? await mergeAndFinish(this.ctx) : finishNoVcs(this.ctx)
    } catch (e) {
      // 与批量链路 failCurrent 同语义:非预期合并异常不留悬挂状态
      const current = this.ctx.deps.tasks.get(this.ctx.task.id)
      if (current && (current.status === 'running' || current.status === 'merging')) {
        this.ctx.deps.tasks.transition(this.ctx.task.id, 'failed', {
          failReason: `internal: ${(e as Error).message}`,
          finishedAt: this.ctx.now().toISOString()
        })
      }
      await this.ctx.log.close()
      this.events.onClosed(this.ctx.deps.tasks.get(this.ctx.task.id) as Task, 'failed')
      throw e
    }
    await this.ctx.log.close()
    this.events.onClosed(task, 'finished')
    return task
  }

  /** 放弃:落 failed(session_abandoned) 并清理 worktree 与分支(归档保留) */
  async abandon(): Promise<Task> {
    this.assertIdle()
    this.state = 'closed'
    await this.transport.close()
    failTask(this.ctx, 'session_abandoned')
    const task = await cleanupTaskWorkspace(
      { tasks: this.ctx.deps.tasks, projects: this.ctx.deps.projects },
      this.ctx.task.id
    )
    await this.ctx.log.close()
    this.events.onClosed(task, 'abandoned')
    return task
  }

  /** 应用退出等外部收口:杀传输,任务落 failed(interrupted 语义由恢复链路兜底) */
  async dispose(reason: string): Promise<void> {
    if (!this.open) return
    await this.failClose(reason)
  }

  private async failClose(failReason: string): Promise<void> {
    if (!this.open) return
    this.state = 'closed'
    await this.transport.close()
    const task = failTask(this.ctx, failReason)
    await this.ctx.log.close()
    this.events.onClosed(task, 'failed')
  }

  private assertIdle(): void {
    if (!this.open) throw new Error('会话已关闭')
    if (this.roundInFlight) throw new Error('本轮进行中,请等待结束或终止会话')
  }

  private renderFirstTurn(text: string): string {
    const template = loadPromptTemplate(
      this.ctx.deps.paths.promptsDir,
      this.ctx.deps.builtinPromptsDir
        ? join(this.ctx.deps.builtinPromptsDir, 'follow-up.md')
        : undefined,
      'follow-up.md'
    )
    return renderPrompt(template, {
      TASK_TEXT: text,
      OUT_DIR: this.ctx.archiveDir,
      PROJECT_PATH: this.ctx.project.path,
      BASE_BRANCH: this.ctx.baseBranch ?? ''
    })
  }

  private appendRoundRecord(round: number, userText: string, result: RoundResult): void {
    const record = {
      round,
      user_text: userText,
      duration_ms: result.durationMs,
      cost_usd: result.costUsd,
      is_error: result.isError,
      at: this.ctx.now().toISOString()
    }
    appendFileSync(join(this.ctx.archiveDir, 'rounds.jsonl'), JSON.stringify(record) + '\n', 'utf-8')
  }
}
