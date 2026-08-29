/**
 * 方案讨论会话引擎(方案确认闸批次 3):awaiting_confirm 任务在「执行前」与主智能体的多轮方案讨论。
 * 与追写面板 FollowUpSession 的关键区别——本引擎不建接力任务、不建 worktree、不碰合并链路,
 * 也**绝不迁移任务状态**:任务全程停在 awaiting_confirm,讨论只修订归档里的 plan.md。
 * 因此轮级失败(超时/进程退出/模板渲染失败)只关会话广播 closed,不落 failed;方案仍有效,可再开讨论。
 *
 * 传输复用 @core/agents/session-transport 的 StreamTransport/RoundSpawnTransport 双实现(stream 优先),
 * 事件回调与 FollowUpSession 同形,供 SessionService 复用同一条 task:session-event 广播协议。
 */

import { join } from 'node:path'
import type { Project, Task } from '@shared/types'
import { OutputLog } from '@core/archive'
import { followUpTransport } from '@core/agents/session'
import {
  RoundSpawnTransport,
  StreamTransport,
  type RoundResult,
  type SessionTransport
} from '@core/agents/session-transport'
import { getPlatformOps } from '@core/platform'
import { loadPromptTemplate, renderPrompt } from '@core/prompt'
import type { ExecutorDeps } from './index'
import type { FollowUpEvents, SessionCloseReason } from './follow-up'

type SessionState = 'open' | 'closed'

export class PlanDiscussionSession {
  private state: SessionState = 'open'
  private round = 0
  private roundInFlight = false

  private constructor(
    private readonly deps: ExecutorDeps,
    private readonly task: Task,
    private readonly project: Project,
    private readonly transport: SessionTransport,
    private readonly events: FollowUpEvents,
    private readonly log: OutputLog,
    private readonly archiveDir: string
  ) {}

  get taskId(): string {
    return this.task.id
  }

  get open(): boolean {
    return this.state === 'open'
  }

  /** 本轮进行中(输入闸门:UI 与壳层同步校验用) */
  get busy(): boolean {
    return this.roundInFlight
  }

  /**
   * 开启方案讨论:守卫(任务存在 / status===awaiting_confirm / sessionId / agent / followUpTransport 非空)
   * → 复用暂停时持久化的归档目录与 worktree(git 项目)→ 选传输就绪。守卫失败在开传输前抛错,
   * 不产生任何副作用,更不迁移任务状态。
   */
  static async start(
    deps: ExecutorDeps,
    taskId: string,
    events: FollowUpEvents
  ): Promise<PlanDiscussionSession> {
    const task = deps.tasks.get(taskId)
    if (!task) throw new Error(`任务不存在: ${taskId}`)
    if (task.status !== 'awaiting_confirm') {
      throw new Error(`任务状态 ${task.status} 不可讨论方案(仅 awaiting_confirm)`)
    }
    if (!task.sessionId) throw new Error('该任务没有可续接的会话(方案阶段未记录 session id)')
    if (!task.agent) throw new Error('该任务没有 agent,无从续会话')
    const agentConfig = deps.config.agents[task.agent]
    const kind = agentConfig ? followUpTransport(agentConfig) : null
    if (!agentConfig || !kind) {
      throw new Error(`agent ${task.agent} 未配置会话续接能力(resume_stream/headless_args)`)
    }
    const project = deps.projects.get(task.projectId)
    if (!project) throw new Error(`任务关联项目不存在: ${task.projectId}`)

    // awaiting_confirm 暂停时必然已持久化归档目录(单点/工作流两条暂停路径都带 archiveDir),下游信任
    const archiveDir = task.archiveDir as string
    const cwd = task.worktreePath ?? project.path
    const sessionId = task.sessionId
    const log = new OutputLog(archiveDir, 'discussion.log')
    const onChunk = (text: string): void => {
      log.append(text)
      events.onChunk(task.id, text)
    }
    // 空闲期进程意外退出的回调经 ref 间接指向本会话(构造完成前的微秒窗口内退出会延迟到首次 sendTurn
    // 以传输错误暴露);讨论的意外退出只关会话,绝不落任务 failed
    const ref: { current: PlanDiscussionSession | null } = { current: null }
    const transport: SessionTransport =
      kind === 'stream'
        ? new StreamTransport({
            config: agentConfig,
            platform: getPlatformOps(),
            cwd,
            sessionId,
            onChunk,
            onUnexpectedExit: () => void ref.current?.close('failed')
          })
        : new RoundSpawnTransport({
            adapter: deps.adapterFor(task.agent),
            cwd,
            outDir: archiveDir,
            sessionId,
            onChunk
          })
    await transport.open()
    const session = new PlanDiscussionSession(deps, task, project, transport, events, log, archiveDir)
    ref.current = session
    return session
  }

  /** 逐轮送话:首轮经 plan-discussion.md 模板注入方案讨论语境,后续轮用户输入原文直发 */
  async sendTurn(text: string): Promise<void> {
    if (!this.open) throw new Error('会话已关闭')
    if (this.roundInFlight) throw new Error('上一轮未结束,不可发送')
    const round = ++this.round
    this.log.append(`\n===== 讨论轮 ${round} =====\n[user] ${text}\n`)
    this.events.onRoundStart(this.task, round)
    this.roundInFlight = true
    const timeoutMs = this.deps.taskTimeoutMs ?? this.deps.config.task_timeout_min * 60_000
    let result: RoundResult
    try {
      // 首轮模板渲染必须在 try 内:同步抛错(如缺 plan-discussion.md)须与传输错误同路 close(不动任务状态)
      const prompt = round === 1 ? this.renderFirstTurn(text) : text
      result = await this.transport.sendTurn(prompt, timeoutMs)
    } catch (e) {
      this.roundInFlight = false
      // 轮级失败只关会话:任务保持 awaiting_confirm,方案仍有效,用户可重新开启讨论
      this.log.append(`\n[dispatch] 讨论轮失败: ${(e as Error).message}\n`)
      await this.close('failed')
      throw e
    }
    this.roundInFlight = false
    this.events.onRoundResult(this.task, round, result)
  }

  /**
   * 关闭讨论:关传输、关日志、广播 closed。幂等(重复调用直接返回)。
   * 不做任何任务状态迁移——确认/放弃的状态迁移分别由 confirmPlan / abandonTask 负责。
   */
  async close(reason: SessionCloseReason = 'finished'): Promise<void> {
    if (!this.open) return
    this.state = 'closed'
    await this.transport.close()
    await this.log.close()
    this.events.onClosed(this.task, reason)
  }

  /** 首轮模板:TASK_TEXT 装任务原文;用户首条讨论输入拼在渲染结果尾部(不新增 PROMPT_VARS 变量) */
  private renderFirstTurn(text: string): string {
    const template = loadPromptTemplate(
      this.deps.paths.promptsDir,
      this.deps.builtinPromptsDir
        ? join(this.deps.builtinPromptsDir, 'plan-discussion.md')
        : undefined,
      'plan-discussion.md'
    )
    const rendered = renderPrompt(template, {
      TASK_TEXT: this.task.text,
      OUT_DIR: this.archiveDir,
      PROJECT_PATH: this.project.path,
      BASE_BRANCH: this.task.baseBranch ?? ''
    })
    return `${rendered}\n\n<user>\n${text}\n</user>\n`
  }
}
