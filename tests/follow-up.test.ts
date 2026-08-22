import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs'
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
import { RoundTimeoutError, SessionExitError, type RoundResult } from '@core/agents/session-transport'
import { runTask, Semaphore, KeyedLock, type ExecutorDeps } from '@core/executor'
import { FollowUpSession, type FollowUpEvents, type SessionCloseReason } from '@core/executor/follow-up'
import { shortId } from '@core/naming'
import type { Project, Task } from '@shared/types'
import { branchExists, makeGitRepo } from './fixtures/git-repo'

const MOCK_SCRIPT = fileURLToPath(new URL('./fixtures/mock-agent.cjs', import.meta.url))
const BUILTIN_PROMPTS = fileURLToPath(new URL('../resources/prompts', import.meta.url))

let home: string
let repo: string
let paths: DispatchPaths
let db: Database
let projects: ProjectStore
let tasks: TaskStore
let deps: ExecutorDeps

/**
 * mock 的 bin 是 node,session_args 前置于脚本路径,必须是 node 合法选项;
 * --title=<uuid> 无副作用,同时覆盖 {SESSION_ID} 占位渲染路径。
 */
const NODE_SAFE_SESSION_ARGS = ['--title={SESSION_ID}']

/** stream 传输的 claude-code 配置:常驻模式经 --mock-mode=stream 进入 */
function streamAgentConfig(): ReturnType<typeof AgentConfigSchema.parse> {
  return AgentConfigSchema.parse({
    bin: process.execPath,
    headless_args: [MOCK_SCRIPT],
    session_args: NODE_SAFE_SESSION_ARGS,
    resume_stream_args: [MOCK_SCRIPT, '--mock-mode=stream']
  })
}

/** 每轮 spawn 降级传输的配置:无 stream 能力,resume_headless_args 指回 mock */
function roundAgentConfig(): ReturnType<typeof AgentConfigSchema.parse> {
  return AgentConfigSchema.parse({
    bin: process.execPath,
    headless_args: [MOCK_SCRIPT],
    session_args: NODE_SAFE_SESSION_ARGS,
    resume_headless_args: [MOCK_SCRIPT]
  })
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dispatch-fu-home-'))
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

/** 人工搭一个带 sessionId 的 done 父任务(不经真实执行,轻量守卫/传输用) */
function makeDoneParent(projectId: string, sessionId: string | null = 'sid-parent'): Task {
  const t = tasks.create({ text: '原任务', projectId, agent: 'claude-code', triggerType: 'immediate' })
  tasks.transition(t.id, 'running')
  if (sessionId) tasks.setSessionId(t.id, sessionId)
  return tasks.transition(t.id, 'done', { finishedAt: new Date().toISOString() })
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

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('startFollowUpSession 守卫', () => {
  it('非 done/failed、无 sessionId、agent 无会话能力分别拒绝', async () => {
    const project = createProject()
    const r = recorder()
    const runningTask = tasks.create({
      text: 'x',
      projectId: project.id,
      agent: 'claude-code',
      triggerType: 'immediate'
    })
    await expect(FollowUpSession.start(deps, runningTask.id, r.events)).rejects.toThrow(
      /done\/failed/
    )
    const noSession = makeDoneParent(project.id, null)
    await expect(FollowUpSession.start(deps, noSession.id, r.events)).rejects.toThrow(
      /没有可续接的会话/
    )
    const parent = makeDoneParent(project.id)
    deps.config.agents['claude-code'] = AgentConfigSchema.parse({
      bin: process.execPath,
      headless_args: [MOCK_SCRIPT]
    })
    await expect(FollowUpSession.start(deps, parent.id, r.events)).rejects.toThrow(/会话续接能力/)
    // 守卫失败发生在建任务前:除守卫入参任务外不产生新任务
    expect(tasks.list()).toHaveLength(3)
  })
})

describe('stream 传输全链路', () => {
  it('真实执行 done(带预生成 session)→ 面板两轮 → 完成合并', async () => {
    process.env.MOCK_MODE = 'success'
    const project = createProject()
    const seed = tasks.create({
      text: 'seed task',
      projectId: project.id,
      agent: 'claude-code',
      triggerType: 'immediate'
    })
    const parent = await runTask(deps, seed.id)
    expect(parent.status).toBe('done')
    // prepareSessionId:fresh run 前预生成并落库
    expect(parent.sessionId).toMatch(/^[0-9a-f-]{36}$/)

    const r = recorder()
    const session = await FollowUpSession.start(deps, parent.id, r.events)
    const follow = tasks.get(session.taskId) as Task
    expect(follow).toMatchObject({
      status: 'running',
      text: `[会话] 接力自 ${shortId(parent.id)}`,
      parentTaskId: parent.id,
      sessionId: parent.sessionId,
      subAgent: null,
      triggerType: 'none'
    })

    await session.sendTurn('第一轮:提交点东西 mock-commit')
    const turnsLog = join(session.workingDir, 'stream-turns.log')
    const firstTurn = readFileSync(turnsLog, 'utf-8')
    // 首轮经 follow-up.md 模板:环境事实 + 机读锚点 + 用户原文
    expect(firstTurn).toContain('Dispatch 接力会话')
    expect(firstTurn).toContain('OUT_DIR: ')
    expect(firstTurn).toContain('第一轮:提交点东西 mock-commit')

    await session.sendTurn('第二轮原文直发')
    const bothTurns = readFileSync(turnsLog, 'utf-8')
    // 后续轮不再渲染模板
    expect(bothTurns.split('Dispatch 接力会话')).toHaveLength(2)
    expect(r.rounds.map((x) => x.round)).toEqual([1, 2])
    expect(r.rounds.every((x) => !x.result.isError)).toBe(true)
    expect(r.chunks.join('')).toContain('echo:')

    const archiveDir = (tasks.get(session.taskId) as Task).archiveDir ?? ''
    const done = await session.finish()
    expect(done.status).toBe('done')
    expect(done.mergedAt).not.toBeNull()
    expect(done.worktreePath).toBeNull()
    // 面板轮次里的提交合并进主检出
    expect(existsSync(join(repo, 'mock-followup.txt'))).toBe(true)
    const finalArchive = (tasks.get(session.taskId) as Task).archiveDir ?? archiveDir
    const rounds = readFileSync(join(finalArchive, 'rounds.jsonl'), 'utf-8').trim().split('\n')
    expect(rounds).toHaveLength(2)
    expect(JSON.parse(rounds[0])).toMatchObject({ round: 1, is_error: false, cost_usd: 0.01 })
    expect(r.closed).toEqual(['finished'])
  })

  it('轮次只改文件未提交 → finish 自动入一笔并合并(不丢改动)', async () => {
    const project = createProject()
    const parent = makeDoneParent(project.id)
    const r = recorder()
    const session = await FollowUpSession.start(deps, parent.id, r.events)
    await session.sendTurn('只写文件不提交 mock-touch')
    const done = await session.finish()
    expect(done.status).toBe('done')
    expect(existsSync(join(repo, 'mock-uncommitted.txt'))).toBe(true)
  })

  it('放弃:failed(session_abandoned) 且 worktree 与分支清理', async () => {
    const project = createProject()
    const parent = makeDoneParent(project.id)
    const r = recorder()
    const session = await FollowUpSession.start(deps, parent.id, r.events)
    await session.sendTurn('随便聊一句')
    const abandoned = await session.abandon()
    expect(abandoned.status).toBe('failed')
    expect(abandoned.failReason).toBe('session_abandoned')
    expect(abandoned.worktreePath).toBeNull()
    expect(abandoned.branch).not.toBeNull()
    expect(await branchExists(repo, abandoned.branch as string)).toBe(false)
    expect(r.closed).toEqual(['abandoned'])
  })

  it('轮超时:RoundTimeoutError 且任务落 failed(timeout_round)', async () => {
    deps.taskTimeoutMs = 500
    const project = createProject()
    const parent = makeDoneParent(project.id)
    const r = recorder()
    const session = await FollowUpSession.start(deps, parent.id, r.events)
    await expect(session.sendTurn('这轮不回话 mock-silent')).rejects.toThrow(RoundTimeoutError)
    const task = tasks.get(session.taskId) as Task
    expect(task.status).toBe('failed')
    expect(task.failReason).toBe('timeout_round')
    expect(r.closed).toEqual(['failed'])
    await expect(session.sendTurn('再来')).rejects.toThrow(/会话已关闭/)
  })

  it('轮内进程退出:SessionExitError 且 failed(session_exit_7)', async () => {
    const project = createProject()
    const parent = makeDoneParent(project.id)
    const r = recorder()
    const session = await FollowUpSession.start(deps, parent.id, r.events)
    await expect(session.sendTurn('中途退出 mock-die')).rejects.toThrow(SessionExitError)
    const task = tasks.get(session.taskId) as Task
    expect(task).toMatchObject({ status: 'failed', failReason: 'session_exit_7' })
    expect(r.closed).toEqual(['failed'])
  })

  it('空闲期进程意外退出:任务落 failed(session_exit_7)', async () => {
    const project = createProject()
    const parent = makeDoneParent(project.id)
    const r = recorder()
    const session = await FollowUpSession.start(deps, parent.id, r.events)
    await session.sendTurn('回话之后再退出 mock-die-after')
    await waitFor(() => (tasks.get(session.taskId) as Task).status === 'failed')
    const task = tasks.get(session.taskId) as Task
    expect(task.failReason).toBe('session_exit_7')
    expect(r.closed).toEqual(['failed'])
  })
})

describe('round(每轮 spawn)降级传输', () => {
  it('无 stream 能力时逐轮 spawn resume,失败轮 isError 不终结会话', async () => {
    process.env.MOCK_MODE = 'noop'
    const config = roundAgentConfig()
    deps.config.agents['claude-code'] = config
    deps.adapterFor = (id) => new GenericCliAdapter(id, config, getPlatformOps())
    const project = createProject()
    const parent = makeDoneParent(project.id)
    const r = recorder()
    const session = await FollowUpSession.start(deps, parent.id, r.events)
    // 首轮带模板(含 OUT_DIR 锚点)→ mock 正常退出
    await session.sendTurn('第一轮')
    expect(r.rounds[0].result.isError).toBe(false)
    // 次轮原文无锚点 → mock exit 64,轮失败但会话继续
    await session.sendTurn('第二轮原文')
    expect(r.rounds[1].result.isError).toBe(true)
    const done = await session.finish()
    expect(done.status).toBe('done')
    expect(r.closed).toEqual(['finished'])
  })
})
