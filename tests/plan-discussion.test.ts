import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openDatabase, ProjectStore, TaskStore } from '@core/db'
import { AgentConfigSchema, loadConfig } from '@core/config'
import { ensureDispatchDirs, resolvePaths, type DispatchPaths } from '@core/paths'
import { getPlatformOps } from '@core/platform'
import { GenericCliAdapter } from '@core/agents/generic-cli-adapter'
import { RoundTimeoutError, type RoundResult } from '@core/agents/session-transport'
import { runTask, Semaphore, KeyedLock, type ExecutorDeps } from '@core/executor'
import { PlanDiscussionSession } from '@core/executor/plan-discussion'
import type { FollowUpEvents, SessionCloseReason } from '@core/executor/follow-up'
import type { Project, Task } from '@shared/types'
import { makeGitRepo } from './fixtures/git-repo'

/**
 * 方案讨论会话引擎测试(方案确认闸批次 3)。传输/mock/fixtures 复用 follow-up.test.ts 的打法,
 * 只有能到 awaiting_confirm 的任务(单点方案跑停 = runTask 一次)才能开讨论;
 * 核心断言:讨论全程不迁移任务状态(始终 awaiting_confirm),轮级失败/关闭都不落 failed。
 */

const MOCK_SCRIPT = fileURLToPath(new URL('./fixtures/mock-agent.cjs', import.meta.url))
const BUILTIN_PROMPTS = fileURLToPath(new URL('../resources/prompts', import.meta.url))

let home: string
let repo: string
let paths: DispatchPaths
let db: Database
let projects: ProjectStore
let tasks: TaskStore
let deps: ExecutorDeps

const NODE_SAFE_SESSION_ARGS = ['--title={SESSION_ID}']

function streamAgentConfig(): ReturnType<typeof AgentConfigSchema.parse> {
  return AgentConfigSchema.parse({
    bin: process.execPath,
    headless_args: [MOCK_SCRIPT],
    session_args: NODE_SAFE_SESSION_ARGS,
    resume_stream_args: [MOCK_SCRIPT, '--mock-mode=stream']
  })
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dispatch-pd-home-'))
  repo = makeGitRepo()
  paths = resolvePaths(home)
  ensureDispatchDirs(paths)
  db = openDatabase(paths.dbFile)
  projects = new ProjectStore(db)
  tasks = new TaskStore(db)
  const config = loadConfig(paths.configFile)
  config.agents['claude-code'] = streamAgentConfig()
  deps = {
    tasks,
    projects,
    config,
    paths,
    adapterFor: (id) => new GenericCliAdapter(id, config.agents[id], getPlatformOps()),
    semaphore: new Semaphore(2),
    mergeLocks: new KeyedLock(),
    taskTimeoutMs: 60_000,
    builtinPromptsDir: BUILTIN_PROMPTS,
    builtinPromptFile: join(BUILTIN_PROMPTS, 'default.md')
  }
})

afterEach(() => {
  delete process.env.MOCK_MODE
  db.close()
  rmSync(home, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

function createProject(): Project {
  return projects.create({ name: 'demo', path: repo })
}

/** 单点方案跑停在 awaiting_confirm:字段(archiveDir/worktreePath/sessionId/phase=plan)由执行器持久化 */
async function runToAwaitingConfirm(projectId: string, text = 'plan me'): Promise<Task> {
  process.env.MOCK_MODE = 'success'
  const task = tasks.create({ text, projectId, agent: 'claude-code', triggerType: 'immediate' })
  const paused = await runTask(deps, task.id)
  expect(paused.status).toBe('awaiting_confirm')
  expect(paused.phase).toBe('plan')
  expect(paused.sessionId).toMatch(/^[0-9a-f-]{36}$/)
  return paused
}

/** 手工构造 awaiting_confirm(守卫测试用,不起真实进程):归档目录真实存在,worktree 缺省 null */
function makeAwaitingConfirm(projectId: string, opts: { sessionId?: string | null } = {}): Task {
  const sessionId = opts.sessionId === undefined ? 'sid-plan' : opts.sessionId
  const t = tasks.create({ text: '待确认原文', projectId, agent: 'claude-code', triggerType: 'immediate' })
  tasks.transition(t.id, 'running', { startedAt: new Date().toISOString() })
  tasks.setPhase(t.id, 'plan')
  if (sessionId) tasks.setSessionId(t.id, sessionId)
  const archiveDir = mkdtempSync(join(home, 'archive-'))
  return tasks.transition(t.id, 'awaiting_confirm', { archiveDir, worktreePath: null, branch: null })
}

interface Recorder {
  events: FollowUpEvents
  chunks: string[]
  rounds: Array<{ round: number; result: RoundResult }>
  closed: SessionCloseReason[]
}

function recorder(): Recorder {
  const chunks: string[] = []
  const rounds: Array<{ round: number; result: RoundResult }> = []
  const closed: SessionCloseReason[] = []
  return {
    chunks,
    rounds,
    closed,
    events: {
      onRoundStart() {},
      onChunk: (_id, text) => chunks.push(text),
      onRoundResult: (_task, round, result) => rounds.push({ round, result }),
      onClosed: (_task, reason) => closed.push(reason)
    }
  }
}

describe('PlanDiscussionSession.start 守卫', () => {
  it('非 awaiting_confirm / 无 sessionId / agent 无会话能力分别拒绝,均不迁移状态', async () => {
    const project = createProject()
    const r = recorder()

    // 非 awaiting_confirm:一个 scheduled 任务
    const scheduled = tasks.create({
      text: 'x',
      projectId: project.id,
      agent: 'claude-code',
      triggerType: 'immediate'
    })
    await expect(PlanDiscussionSession.start(deps, scheduled.id, r.events)).rejects.toThrow(
      /awaiting_confirm/
    )

    // awaiting_confirm 但无 sessionId
    const noSession = makeAwaitingConfirm(project.id, { sessionId: null })
    await expect(PlanDiscussionSession.start(deps, noSession.id, r.events)).rejects.toThrow(
      /没有可续接的会话/
    )
    expect((tasks.get(noSession.id) as Task).status).toBe('awaiting_confirm')

    // agent 无 resume 能力(仅 headless_args)
    const noResume = makeAwaitingConfirm(project.id)
    deps.config.agents['claude-code'] = AgentConfigSchema.parse({
      bin: process.execPath,
      headless_args: [MOCK_SCRIPT]
    })
    await expect(PlanDiscussionSession.start(deps, noResume.id, r.events)).rejects.toThrow(
      /会话续接能力/
    )
    expect((tasks.get(noResume.id) as Task).status).toBe('awaiting_confirm')
    // 守卫失败无广播
    expect(r.closed).toEqual([])
  })
})

describe('PlanDiscussionSession 真实 stream 会话', () => {
  it('首轮渲染 plan-discussion.md 模板 + 追加用户输入;discussion.log 追加;任务仍 awaiting_confirm', async () => {
    const project = createProject()
    const paused = await runToAwaitingConfirm(project.id)
    const r = recorder()
    const session = await PlanDiscussionSession.start(deps, paused.id, r.events)

    await session.sendTurn('把第 2 步拆细一点 mydiscuss')

    // 首轮经模板:方案讨论语境 + 机读锚点 + 用户原文,全文进 worktree/stream-turns.log
    const turnsLog = readFileSync(join(paused.worktreePath as string, 'stream-turns.log'), 'utf-8')
    expect(turnsLog).toContain('方案讨论')
    expect(turnsLog).toContain('OUT_DIR: ')
    expect(turnsLog).toContain('把第 2 步拆细一点 mydiscuss')
    // 任务原文(TASK_TEXT)注入模板 <task>
    expect(turnsLog).toContain('plan me')

    // discussion.log 落在归档目录,含轮头、[user] 与 agent 回复
    const discussionLog = readFileSync(join(paused.archiveDir as string, 'discussion.log'), 'utf-8')
    expect(discussionLog).toContain('===== 讨论轮 1 =====')
    expect(discussionLog).toContain('[user] 把第 2 步拆细一点 mydiscuss')
    expect(discussionLog).toContain('echo:')
    expect(r.rounds.map((x) => x.round)).toEqual([1])

    // 讨论不迁移任务状态
    expect((tasks.get(paused.id) as Task).status).toBe('awaiting_confirm')

    await session.close()
    expect(r.closed).toEqual(['finished'])
  }, 15_000)

  it('串行闸门:上一轮进行中再发抛错', async () => {
    const project = createProject()
    const paused = await runToAwaitingConfirm(project.id)
    const r = recorder()
    const session = await PlanDiscussionSession.start(deps, paused.id, r.events)

    const first = session.sendTurn('第一轮')
    await expect(session.sendTurn('抢跑第二句')).rejects.toThrow(/上一轮未结束/)
    await first
    await session.close()
  }, 15_000)

  it('轮超时:RoundTimeoutError,任务仍 awaiting_confirm,close(failed) 广播', async () => {
    const project = createProject()
    const paused = await runToAwaitingConfirm(project.id)
    const r = recorder()
    const session = await PlanDiscussionSession.start(deps, paused.id, r.events)
    // 讨论轮用短超时(方案跑已在上面用默认 60s 完成,此处改不影响它)
    deps.taskTimeoutMs = 500

    await expect(session.sendTurn('这轮不回话 mock-silent')).rejects.toThrow(RoundTimeoutError)

    // 轮级失败只关会话:任务不动,方案仍有效
    expect((tasks.get(paused.id) as Task).status).toBe('awaiting_confirm')
    expect(session.open).toBe(false)
    expect(r.closed).toEqual(['failed'])
    // 会话已关,再发报错
    await expect(session.sendTurn('再来')).rejects.toThrow(/会话已关闭/)
  }, 15_000)

  it('close 幂等:重复关闭只广播一次 closed', async () => {
    const project = createProject()
    const paused = await runToAwaitingConfirm(project.id)
    const r = recorder()
    const session = await PlanDiscussionSession.start(deps, paused.id, r.events)

    await session.close()
    await session.close()
    expect(r.closed).toEqual(['finished'])
    expect(session.open).toBe(false)
    expect((tasks.get(paused.id) as Task).status).toBe('awaiting_confirm')
  }, 15_000)
})
