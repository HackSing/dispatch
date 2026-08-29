import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import type { AgentAdapter } from '@core/agents/types'
import { runTask, Semaphore, KeyedLock, type ExecutorDeps } from '@core/executor'
import { sanitizeName, shortId } from '@core/naming'
import type { AgentId, Project, Task, TaskPhase } from '@shared/types'
import { headOf, makeGitRepo } from './fixtures/git-repo'

/**
 * W1b 工作流编排测试:mock 三角色(主=plan+review、子=implement)覆盖
 * Plan workflow-stage1 success_criteria 第 2 条全部路径。
 * 主与审查在真实编排中共用 task.agent 的同一 adapter,故 mock 主模式按提示词锚点区分
 * plan/review 阶段;子智能体是独立 AgentConfig(--mock-mode 随 headless_args 注入)。
 */

const MOCK_SCRIPT = fileURLToPath(new URL('./fixtures/mock-agent.cjs', import.meta.url))
const BUILTIN_PROMPTS_DIR = fileURLToPath(new URL('../resources/prompts', import.meta.url))
const MOCK_ENV_KEYS = [
  'MOCK_MODE',
  'MOCK_FILE',
  'MOCK_CONTENT',
  'MOCK_WAIT_FILE',
  'MOCK_REVIEW_PASS_FROM',
  'MOCK_DUMP_PROMPT'
]

let home: string
let repo: string
let paths: DispatchPaths
let db: Database
let projects: ProjectStore
let tasks: TaskStore
let changes: Task[]
let deps: ExecutorDeps

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dispatch-wfexec-'))
  repo = makeGitRepo()
  paths = resolvePaths(home)
  ensureDispatchDirs(paths)
  db = openDatabase(paths.dbFile)
  projects = new ProjectStore(db)
  changes = []
  tasks = new TaskStore(db, (t) => changes.push(t))
  deps = {
    tasks,
    projects,
    config: loadConfig(paths.configFile),
    paths,
    adapterFor: () => {
      throw new Error('测试须先 wireAdapters')
    },
    semaphore: new Semaphore(2),
    mergeLocks: new KeyedLock(),
    taskTimeoutMs: 60_000,
    builtinPromptsDir: BUILTIN_PROMPTS_DIR,
    workflowPhaseTimeoutsMs: { plan: 30_000, implement: 30_000, review: 30_000 }
  }
})

afterEach(() => {
  for (const key of MOCK_ENV_KEYS) delete process.env[key]
  db.close()
  rmSync(home, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

function mockAdapter(id: AgentId, mode: string | null): GenericCliAdapter {
  const args = mode === null ? [MOCK_SCRIPT] : [MOCK_SCRIPT, `--mock-mode=${mode}`]
  return new GenericCliAdapter(
    id,
    AgentConfigSchema.parse({ bin: process.execPath, headless_args: args }),
    getPlatformOps()
  )
}

/** 主(plan+review 同一 adapter,真实编排即如此)与子各自独立 AgentConfig 包装同一 mock 脚本 */
function wireAdapters(mainMode: string | null, subMode: string | null): void {
  const byId: Partial<Record<AgentId, AgentAdapter>> = {
    'claude-code': mockAdapter('claude-code', mainMode),
    qwen: mockAdapter('qwen', subMode)
  }
  deps.adapterFor = (agent: AgentId): AgentAdapter => {
    const adapter = byId[agent]
    if (!adapter) throw new Error(`测试未接线 agent: ${agent}`)
    return adapter
  }
}

function createProject(overrides: Partial<Parameters<ProjectStore['create']>[0]> = {}): Project {
  return projects.create({ name: 'demo', path: repo, ...overrides })
}

function createWorkflowTask(projectId: string, text = 'workflow the login fix'): Task {
  return tasks.create({
    text,
    projectId,
    agent: 'claude-code',
    subAgent: 'qwen',
    triggerType: 'immediate'
  })
}

function localDate(d = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function archiveDirOf(project: Project, task: Task): string {
  return join(paths.archivesDir, sanitizeName(project.name), `${localDate()}-${shortId(task.id)}`)
}

function worktreeDirOf(project: Project, task: Task): string {
  return join(paths.worktreesDir, sanitizeName(project.name), task.id)
}

/** running 期间的 phase/reviewRound 变更序列(transition 进 running 的初始 null 也在内) */
function phaseTrail(): Array<{ phase: TaskPhase | null; reviewRound: number }> {
  return changes
    .filter((c) => c.status === 'running')
    .map((c) => ({ phase: c.phase, reviewRound: c.reviewRound }))
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
}

/**
 * 方案确认闸后工作流的完整跑法:方案跑(首个 runTask)停 awaiting_confirm → 模拟 confirmPlan
 * 迁移 scheduled → 执行跑(第二个 runTask)跳过 plan 直入 implement/review。
 * 方案阶段本身就失败(timeout_plan/no_plan/模板缺失)时首跑直接返回 failed,无暂停,原样透传。
 */
async function runWorkflowConfirmed(taskId: string): Promise<Task> {
  const first = await runTask(deps, taskId)
  if (first.status !== 'awaiting_confirm') return first
  tasks.transition(taskId, 'scheduled', {})
  return runTask(deps, taskId)
}

describe('runWorkflow 工作流路径', () => {
  it('① pass 直通:plan→implement→review pass→清 phase→合并 done', async () => {
    wireAdapters('review_pass', 'success')
    const project = createProject()
    const task = createWorkflowTask(project.id)
    const before = headOf(repo, 'main')

    const result = await runWorkflowConfirmed(task.id)

    expect(result.status).toBe('done')
    expect(result.failReason).toBeNull()
    expect(result.phase).toBeNull()
    expect(result.reviewRound).toBe(1)
    expect(result.mergedAt).toBeTruthy()
    expect(headOf(repo, 'main')).not.toBe(before)
    expect(existsSync(worktreeDirOf(project, task))).toBe(false)
    // 状态链与 phase 轨迹(方案跑停 awaiting_confirm,确认后执行跑;两次 running 段)
    expect(changes.map((c) => c.status)).toEqual([
      'scheduled',
      'running',
      'running',
      'awaiting_confirm',
      'scheduled',
      'running',
      'running',
      'running',
      'running',
      'merging',
      'done'
    ])
    expect(phaseTrail()).toEqual([
      { phase: null, reviewRound: 0 }, // 方案跑 → running
      { phase: 'plan', reviewRound: 0 }, // 方案跑 setPhase plan
      { phase: 'plan', reviewRound: 0 }, // 执行跑 → running(phase 冻结持久化为 plan)
      { phase: 'implement', reviewRound: 0 },
      { phase: 'review', reviewRound: 1 },
      { phase: null, reviewRound: 1 }
    ])
    // 归档产物:三段各自产物齐全,无返工留痕
    const archive = archiveDirOf(project, task)
    for (const f of ['task.md', 'plan.md', 'result.json', 'review-r1.json', 'output.log']) {
      expect(existsSync(join(archive, f)), f).toBe(true)
    }
    expect(existsSync(join(archive, 'result-r1.json'))).toBe(false)
    expect(existsSync(join(archive, 'review-r2.json'))).toBe(false)
    expect(readJson(join(archive, 'review-r1.json')).verdict).toBe('pass')
    // output.log 阶段分隔行
    const log = readFileSync(join(archive, 'output.log'), 'utf-8')
    expect(log).toContain('===== phase: plan =====')
    expect(log).toContain('===== phase: implement round 1 =====')
    expect(log).toContain('===== phase: review round 1 =====')
  }, 20_000)

  it('② reject→返工(REVIEW_FEEDBACK 注入上轮 issues)→pass→done,归档留痕', async () => {
    process.env.MOCK_REVIEW_PASS_FROM = '2'
    process.env.MOCK_DUMP_PROMPT = '1'
    wireAdapters('review_reject', 'success')
    const project = createProject()
    const task = createWorkflowTask(project.id)

    const result = await runWorkflowConfirmed(task.id)

    expect(result.status).toBe('done')
    expect(result.failReason).toBeNull()
    expect(result.phase).toBeNull()
    expect(result.reviewRound).toBe(2)
    expect(result.mergedAt).toBeTruthy()
    expect(phaseTrail()).toEqual([
      { phase: null, reviewRound: 0 },
      { phase: 'plan', reviewRound: 0 },
      { phase: 'plan', reviewRound: 0 }, // 执行跑 → running(phase 冻结持久化为 plan)
      { phase: 'implement', reviewRound: 0 },
      { phase: 'review', reviewRound: 1 },
      { phase: 'implement', reviewRound: 1 },
      { phase: 'review', reviewRound: 2 },
      { phase: null, reviewRound: 2 }
    ])
    // 留痕:r1 实现产物与两轮审查文件并存,result.json 留给末轮
    const archive = archiveDirOf(project, task)
    for (const f of ['result.json', 'result-r1.json', 'review-r1.json', 'review-r2.json']) {
      expect(existsSync(join(archive, f)), f).toBe(true)
    }
    expect(readJson(join(archive, 'review-r1.json')).verdict).toBe('reject')
    expect(readJson(join(archive, 'review-r2.json')).verdict).toBe('pass')
    expect(readJson(join(archive, 'result-r1.json')).status).toBe('success')
    // REVIEW_FEEDBACK 注入:首轮为「无」,返工轮含上轮审查 issues 原文
    // 模板文件行尾随本机 git checkout(autocrlf)而定,断言前统一归一为 LF
    const prompts = readFileSync(join(archive, 'mock-prompts.log'), 'utf-8').replaceAll(
      '\r\n',
      '\n'
    )
    expect(prompts).toContain('<review_feedback>\n无\n</review_feedback>')
    expect(prompts).toContain('mock-issue-r1: 实现与方案不符')
    expect(prompts).toContain('请修复标记 r1')
    const log = readFileSync(join(archive, 'output.log'), 'utf-8')
    expect(log).toContain('===== phase: implement round 2 =====')
    expect(log).toContain('===== phase: review round 2 =====')
  }, 25_000)

  it('③ 连续 reject×3 → failed: review_rejected,phase 留在 review 供追溯', async () => {
    wireAdapters('review_reject', 'success')
    const project = createProject()
    const task = createWorkflowTask(project.id)

    const result = await runWorkflowConfirmed(task.id)

    expect(result.status).toBe('failed')
    expect(result.failReason).toBe('review_rejected')
    // 失败前不清 phase:凶案现场留在第 3 轮审查
    expect(result.phase).toBe('review')
    expect(result.reviewRound).toBe(3)
    expect(result.finishedAt).toBeTruthy()
    expect(existsSync(worktreeDirOf(project, task))).toBe(true)
    const archive = archiveDirOf(project, task)
    for (const f of [
      'result-r1.json',
      'result-r2.json',
      'review-r1.json',
      'review-r2.json',
      'review-r3.json'
    ]) {
      expect(existsSync(join(archive, f)), f).toBe(true)
    }
    expect(readJson(join(archive, 'review-r3.json')).verdict).toBe('reject')
    expect(phaseTrail().map((p) => p.phase)).toEqual([
      null,
      'plan',
      'plan', // 执行跑 → running(phase 冻结持久化为 plan)
      'implement',
      'review',
      'implement',
      'review',
      'implement',
      'review'
    ])
  }, 30_000)

  it('④ 审查越权修改 worktree → failed: review_modified(判定文件合法也不豁免)', async () => {
    wireAdapters('review_modify', 'success')
    const project = createProject()
    const task = createWorkflowTask(project.id)

    const result = await runWorkflowConfirmed(task.id)

    expect(result.status).toBe('failed')
    expect(result.failReason).toBe('review_modified')
    expect(result.phase).toBe('review')
    expect(result.reviewRound).toBe(1)
    // 审查产物本身是合法 pass 判定,证明越权检查优先于 verdict 判定
    const reviewFile = join(archiveDirOf(project, task), 'review-r1.json')
    expect(existsSync(reviewFile)).toBe(true)
    expect(readJson(reviewFile).verdict).toBe('pass')
    // 越权痕迹保留在 worktree 供排查
    expect(existsSync(join(worktreeDirOf(project, task), 'review-tamper.txt'))).toBe(true)
  }, 20_000)

  it.each<{
    name: string
    mainMode: string
    subMode: string
    timeouts?: Partial<Record<TaskPhase, number>>
    failReason: string
    phase: TaskPhase
    reviewRound: number
  }>([
    {
      name: 'plan 超时 → timeout_plan',
      mainMode: 'hang',
      subMode: 'success',
      timeouts: { plan: 1500 },
      failReason: 'timeout_plan',
      phase: 'plan',
      reviewRound: 0
    },
    {
      name: 'plan 缺产物 → no_plan',
      mainMode: 'noop',
      subMode: 'success',
      failReason: 'no_plan',
      phase: 'plan',
      reviewRound: 0
    },
    {
      name: 'implement 超时 → timeout_implement',
      mainMode: 'review_pass',
      subMode: 'hang',
      timeouts: { implement: 1500 },
      failReason: 'timeout_implement',
      phase: 'implement',
      reviewRound: 0
    },
    {
      name: 'implement 缺产物 → no_result',
      mainMode: 'review_pass',
      subMode: 'noop',
      failReason: 'no_result',
      phase: 'implement',
      reviewRound: 0
    },
    {
      name: 'review 超时 → timeout_review',
      mainMode: 'review_hang',
      subMode: 'success',
      timeouts: { review: 1500 },
      failReason: 'timeout_review',
      phase: 'review',
      reviewRound: 1
    },
    {
      name: 'review 缺产物 → no_review',
      mainMode: 'review_none',
      subMode: 'success',
      failReason: 'no_review',
      phase: 'review',
      reviewRound: 1
    },
    {
      name: 'review 坏 JSON → bad_review',
      mainMode: 'review_bad_json',
      subMode: 'success',
      failReason: 'bad_review',
      phase: 'review',
      reviewRound: 1
    },
    {
      name: 'review verdict 非法 → bad_review',
      mainMode: 'review_bad_verdict',
      subMode: 'success',
      failReason: 'bad_review',
      phase: 'review',
      reviewRound: 1
    }
  ])(
    '⑤ $name,phase 留在末阶段',
    async ({ mainMode, subMode, timeouts, failReason, phase, reviewRound }) => {
      wireAdapters(mainMode, subMode)
      if (timeouts) {
        deps.workflowPhaseTimeoutsMs = { ...deps.workflowPhaseTimeoutsMs, ...timeouts }
      }
      const project = createProject()
      const task = createWorkflowTask(project.id)

      const result = await runWorkflowConfirmed(task.id)

      expect(result.status).toBe('failed')
      expect(result.failReason).toBe(failReason)
      expect(result.phase).toBe(phase)
      expect(result.reviewRound).toBe(reviewRound)
      expect(result.finishedAt).toBeTruthy()
    },
    20_000
  )

  it('非 git 项目:跳过审查越权修改检测(日志注明),pass → done(no_vcs)', async () => {
    // review_modify 在非 git 项目下不构成 review_modified——检测按约定跳过
    wireAdapters('review_modify', 'success')
    const plainDir = mkdtempSync(join(tmpdir(), 'dispatch-wfplain-'))
    try {
      const project = createProject({ name: 'plain', path: plainDir })
      const task = createWorkflowTask(project.id)

      const result = await runWorkflowConfirmed(task.id)

      expect(result.status).toBe('done')
      expect(result.failReason).toBeNull()
      expect(result.phase).toBeNull()
      expect(result.mergedAt).toBeNull()
      const archive = archiveDirOf(project, task)
      expect(readJson(join(archive, 'review-r1.json')).verdict).toBe('pass')
      expect(readFileSync(join(archive, 'output.log'), 'utf-8')).toContain(
        '非 git 项目:跳过审查越权修改检测'
      )
    } finally {
      rmSync(plainDir, { recursive: true, force: true })
    }
  }, 20_000)

  it('接缝守卫:未接线 builtinPromptsDir 且用户模板缺失 → failed(模板缺失明确报错)', async () => {
    deps.builtinPromptsDir = undefined
    wireAdapters('review_pass', 'success')
    const project = createProject()
    const task = createWorkflowTask(project.id)

    const result = await runTask(deps, task.id)

    expect(result.status).toBe('failed')
    expect(result.failReason).toMatch(/internal: 提示词模板缺失: wf-plan\.md/)
    expect(result.phase).toBe('plan')
  }, 20_000)
})

describe('单点回归(subAgent=null 走既有路径)', () => {
  it('⑦ 单点两跑:方案跑停 awaiting_confirm → 确认 → 执行跑 done,无工作流产物', async () => {
    process.env.MOCK_MODE = 'success'
    wireAdapters(null, null)
    const project = createProject()
    const task = tasks.create({
      text: 'single agent task',
      projectId: project.id,
      agent: 'claude-code',
      triggerType: 'immediate'
    })

    const paused = await runTask(deps, task.id)
    expect(paused.status).toBe('awaiting_confirm')
    expect(paused.phase).toBe('plan')
    tasks.transition(task.id, 'scheduled', {}) // 模拟批次3 confirmPlan
    const result = await runTask(deps, task.id)

    expect(result.status).toBe('done')
    expect(result.failReason).toBeNull()
    expect(result.subAgent).toBeNull()
    expect(result.reviewRound).toBe(0)
    expect(result.phase).toBeNull()
    // 状态迁移主干(setPhase 的重复 running 广播折叠)
    const trail: string[] = []
    for (const c of changes) if (trail[trail.length - 1] !== c.status) trail.push(c.status)
    expect(trail).toEqual([
      'scheduled',
      'running',
      'awaiting_confirm',
      'scheduled',
      'running',
      'merging',
      'done'
    ])
    const archive = archiveDirOf(project, task)
    expect(existsSync(join(archive, 'result.json'))).toBe(true)
    expect(existsSync(join(archive, 'review-r1.json'))).toBe(false)
    // 单点两跑不产生工作流的 ===== phase: 分隔行(那是 wf-* 三段编排的日志)
    const log = readFileSync(join(archive, 'output.log'), 'utf-8')
    expect(log).not.toContain('===== phase:')
  }, 20_000)
})

describe('工作流方案确认闸(批次3:首跑暂停 + resume 跳过 runPlanPhase)', () => {
  it('首跑方案判过 → 停 awaiting_confirm,phase=plan,字段持久化,未进 implement/review', async () => {
    wireAdapters('review_pass', 'success')
    const project = createProject()
    const task = createWorkflowTask(project.id)

    const paused = await runTask(deps, task.id)

    expect(paused.status).toBe('awaiting_confirm')
    expect(paused.phase).toBe('plan')
    // 暂停时持久化归档/worktree/branch(确认重入的复用字段)
    expect(paused.archiveDir).toBe(archiveDirOf(project, task))
    expect(paused.worktreePath).toBe(worktreeDirOf(project, task))
    expect(paused.branch).toMatch(/^task\//)
    const archive = archiveDirOf(project, task)
    expect(existsSync(join(archive, 'plan.md'))).toBe(true)
    expect(existsSync(join(archive, 'result.json'))).toBe(false)
    expect(existsSync(join(archive, 'review-r1.json'))).toBe(false)
    // 只跑了 plan 阶段,未进 implement/review
    const log = readFileSync(join(archive, 'output.log'), 'utf-8')
    expect(log).toContain('===== phase: plan =====')
    expect(log).not.toContain('===== phase: implement')
    expect(log).not.toContain('===== phase: review')
    expect(log).toContain('暂停等待用户确认')
  }, 20_000)

  it('首跑暂停 → 确认 → 重入跳过 plan 直入 implement/review → 合并 done', async () => {
    wireAdapters('review_pass', 'success')
    const project = createProject()
    const task = createWorkflowTask(project.id)
    const before = headOf(repo, 'main')

    const paused = await runTask(deps, task.id)
    expect(paused.status).toBe('awaiting_confirm')
    tasks.transition(task.id, 'scheduled', {}) // 模拟批次3 confirmPlan 迁移
    const result = await runTask(deps, task.id)

    expect(result.status).toBe('done')
    expect(result.failReason).toBeNull()
    expect(result.phase).toBeNull()
    expect(result.mergedAt).toBeTruthy()
    expect(headOf(repo, 'main')).not.toBe(before)
    expect(existsSync(worktreeDirOf(project, task))).toBe(false)
    // 重入跳过 plan:整段 output.log 里 plan 阶段只出现一次(首跑),implement/review 照跑
    const archive = archiveDirOf(project, task)
    const log = readFileSync(join(archive, 'output.log'), 'utf-8')
    expect(log.split('===== phase: plan =====')).toHaveLength(2)
    expect(log).toContain('===== phase: implement round 1 =====')
    expect(log).toContain('===== phase: review round 1 =====')
    expect(log).toContain('重入执行(跳过方案阶段)')
    expect(readJson(join(archive, 'review-r1.json')).verdict).toBe('pass')
  }, 25_000)

  it('phase=plan 且 plan.md 存在(手工构造重入态)→ 跳过 runPlanPhase 直入 implement → done(no_vcs)', async () => {
    wireAdapters('review_pass', 'success')
    const plainDir = mkdtempSync(join(tmpdir(), 'dispatch-wfplain-'))
    try {
      const project = createProject({ name: 'plain', path: plainDir })
      const task = createWorkflowTask(project.id)
      // 直接置字段模拟 running→awaiting_confirm→scheduled(confirm)后的持久化结果,单测 resume 分支
      tasks.transition(task.id, 'running', { startedAt: new Date().toISOString(), baseBranch: null })
      const archive = archiveDirOf(project, task)
      mkdirSync(archive, { recursive: true })
      writeFileSync(join(archive, 'plan.md'), '# 已确认方案\n\n- 步骤: 由子智能体实现\n')
      tasks.setPhase(task.id, 'plan')
      tasks.transition(task.id, 'awaiting_confirm', {
        archiveDir: archive,
        worktreePath: null,
        branch: null
      })
      tasks.transition(task.id, 'scheduled', {}) // 确认放行

      const result = await runTask(deps, task.id)

      expect(result.status).toBe('done')
      expect(result.failReason).toBeNull()
      expect(result.phase).toBeNull()
      // 跳过 runPlanPhase 的证据:output.log 无 plan 阶段分隔行,implement/review 照跑
      const log = readFileSync(join(archive, 'output.log'), 'utf-8')
      expect(log).not.toContain('===== phase: plan =====')
      expect(log).toContain('===== phase: implement round 1 =====')
      expect(log).toContain('===== phase: review round 1 =====')
      expect(log).toContain('重入执行(跳过方案阶段)')
      // 已确认的 plan.md 未被重写
      expect(readFileSync(join(archive, 'plan.md'), 'utf-8')).toContain('已确认方案')
      expect(readJson(join(archive, 'review-r1.json')).verdict).toBe('pass')
    } finally {
      rmSync(plainDir, { recursive: true, force: true })
    }
  }, 20_000)
})
