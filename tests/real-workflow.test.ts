import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentId } from '@shared/types'
import type { Database } from 'better-sqlite3'
import { openDatabase, TaskStore, ProjectStore } from '@core/db'
import { ensureDispatchDirs, resolvePaths } from '@core/paths'
import { ConfigSchema, AgentConfigSchema } from '@core/config'
import { GenericCliAdapter } from '@core/agents/generic-cli-adapter'
import { getPlatformOps } from '@core/platform'
import { runTask, Semaphore, KeyedLock, type ExecutorDeps } from '@core/executor'
import { makeGitRepo } from './fixtures/git-repo'

/**
 * 工作流 L3 实机验收(Plan workflow-stage1 / Acceptance c3),消耗真实 agent 配额。
 * RUN_REAL_WORKFLOW=1 启用。
 */
const enabled = process.env.RUN_REAL_WORKFLOW === '1'

interface Harness {
  db: Database
  deps: ExecutorDeps
  tasks: TaskStore
  repo: string
  home: string
  projectId: string
}

function makeHarness(subOverride?: (agent: AgentId) => GenericCliAdapter | null): Harness {
  const home = mkdtempSync(join(tmpdir(), 'dispatch-real-wf-'))
  const paths = resolvePaths(home)
  ensureDispatchDirs(paths)
  const db = openDatabase(paths.dbFile)
  const tasks = new TaskStore(db)
  const projects = new ProjectStore(db)
  const config = ConfigSchema.parse({})
  const repo = makeGitRepo('dispatch-real-wf-repo-')
  const project = projects.create({ name: 'real-wf', path: repo })
  const deps: ExecutorDeps = {
    tasks,
    projects,
    config,
    paths,
    adapterFor: (agent: AgentId) =>
      subOverride?.(agent) ?? new GenericCliAdapter(agent, config.agents[agent], getPlatformOps()),
    semaphore: new Semaphore(1),
    mergeLocks: new KeyedLock(),
    builtinPromptFile: resolve(__dirname, '../resources/prompts/default.md'),
    builtinPromptsDir: resolve(__dirname, '../resources/prompts')
  }
  return { db, deps, tasks, repo, home, projectId: project.id }
}

function cleanup(h: Harness): void {
  h.db.close()
  rmSync(h.home, { recursive: true, force: true })
  rmSync(h.repo, { recursive: true, force: true })
}

describe.skipIf(!enabled)('工作流实机验收', () => {
  it('直通:claude 主方案 → qwen 子实现 → claude 审查 pass → 合并', { timeout: 15 * 60_000 }, async () => {
    const h = makeHarness()
    const task = h.tasks.create({
      text: '在仓库根目录新建 GREETING.md,内容为一行:hello workflow。不改其他文件。',
      projectId: h.projectId,
      agent: 'claude-code',
      subAgent: 'qwen',
      triggerType: 'immediate'
    })
    const finished = await runTask(h.deps, task.id)
    const archive = finished.archiveDir!
    const logTail = existsSync(join(archive, 'output.log'))
      ? readFileSync(join(archive, 'output.log'), 'utf-8').slice(-3000)
      : '(无日志)'
    expect(finished.status, `fail_reason=${finished.failReason} phase=${finished.phase}\n${logTail}`).toBe('done')
    expect(existsSync(join(archive, 'plan.md'))).toBe(true)
    const review = JSON.parse(readFileSync(join(archive, 'review-r1.json'), 'utf-8'))
    expect(review.verdict).toBe('pass')
    expect(readFileSync(join(h.repo, 'GREETING.md'), 'utf-8')).toContain('hello workflow')
    cleanup(h)
  })

  it('返工:破坏性子实现被真实审查者打回,修正后通过', { timeout: 15 * 60_000 }, async () => {
    const h = makeHarness((agent) => {
      if (agent !== 'qwen') return null
      // 子智能体换成破坏性 mock:首轮写 VERSION=1(违背方案),返工轮写 VERSION=2
      const cfg = AgentConfigSchema.parse({
        bin: process.execPath,
        headless_args: [resolve(__dirname, 'fixtures/real-wf-sub.cjs')],
        prompt_via: 'stdin'
      })
      return new GenericCliAdapter('qwen', cfg, getPlatformOps())
    })
    const task = h.tasks.create({
      text: '把仓库根目录 NOTES.md 的内容设置为唯一一行:VERSION=2。不改其他文件。',
      projectId: h.projectId,
      agent: 'claude-code',
      subAgent: 'qwen',
      triggerType: 'immediate'
    })
    const finished = await runTask(h.deps, task.id)
    const archive = finished.archiveDir!
    const r1 = JSON.parse(readFileSync(join(archive, 'review-r1.json'), 'utf-8'))
    expect(r1.verdict, `真实审查者未能抓住违背方案的实现(VERSION=1):${JSON.stringify(r1)}`).toBe(
      'reject'
    )
    expect(finished.status, `fail_reason=${finished.failReason} phase=${finished.phase}`).toBe('done')
    const r2 = JSON.parse(readFileSync(join(archive, 'review-r2.json'), 'utf-8'))
    expect(r2.verdict).toBe('pass')
    // 返工留痕:首轮 result 副本存在
    expect(existsSync(join(archive, 'result-r1.json'))).toBe(true)
    expect(readFileSync(join(h.repo, 'NOTES.md'), 'utf-8').trim()).toBe('VERSION=2')
    cleanup(h)
  })
})
