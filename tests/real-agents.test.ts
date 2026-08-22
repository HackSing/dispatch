import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_IDS, type AgentId } from '@shared/types'
import { openDatabase, TaskStore, ProjectStore } from '@core/db'
import { ensureDispatchDirs, resolvePaths } from '@core/paths'
import { ConfigSchema } from '@core/config'
import { GenericCliAdapter } from '@core/agents/generic-cli-adapter'
import { getPlatformOps } from '@core/platform'
import { runTask, Semaphore, KeyedLock, type ExecutorDeps } from '@core/executor'
import { makeGitRepo } from './fixtures/git-repo'

/**
 * L3 实机联调(参数化):真实 agent CLI + 真模板 + 真 git 仓库,验证 DEFAULT_AGENTS 校准值。
 * 消耗真实配额且依赖各 CLI 本机登录态,默认全部跳过;
 * RUN_REAL_AGENTS=codex,kimi,qwen 按名启用(claude-code 另有 real-claude.test.ts,此处同样支持)。
 */
const requested = (process.env.RUN_REAL_AGENTS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const unknown = requested.filter((a) => !(AGENT_IDS as readonly string[]).includes(a))
if (unknown.length > 0) {
  throw new Error(`RUN_REAL_AGENTS 含未知 agent: ${unknown.join(', ')}(可选值 ${AGENT_IDS.join(', ')})`)
}

async function runRealAgent(agent: AgentId): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), `dispatch-real-${agent}-`))
  const paths = resolvePaths(home)
  ensureDispatchDirs(paths)
  const db = openDatabase(paths.dbFile)
  const tasks = new TaskStore(db)
  const projects = new ProjectStore(db)
  const config = ConfigSchema.parse({})
  const repo = makeGitRepo(`dispatch-real-${agent}-repo-`)
  const project = projects.create({ name: `real-${agent}`, path: repo })
  const task = tasks.create({
    text: '在仓库根目录的 file.txt 末尾追加一行文本:hello from dispatch。不要改动其他文件。',
    projectId: project.id,
    agent,
    triggerType: 'immediate'
  })

  const deps: ExecutorDeps = {
    tasks,
    projects,
    config,
    paths,
    adapterFor: (id: AgentId) => new GenericCliAdapter(id, config.agents[id], getPlatformOps()),
    semaphore: new Semaphore(1),
    mergeLocks: new KeyedLock(),
    builtinPromptFile: resolve(__dirname, '../resources/prompts/default.md')
  }

  const finished = await runTask(deps, task.id)
  const archive = finished.archiveDir
  const logFile = archive ? join(archive, 'output.log') : null
  const logTail =
    logFile && existsSync(logFile) ? readFileSync(logFile, 'utf-8').slice(-2000) : '(无日志)'

  expect(finished.status, `fail_reason=${finished.failReason}\n日志尾部:\n${logTail}`).toBe('done')
  expect(existsSync(join(archive!, 'plan.md'))).toBe(true)
  const result = JSON.parse(readFileSync(join(archive!, 'result.json'), 'utf-8'))
  expect(['success', 'partial']).toContain(result.status)
  // 合并已推进:主工作区文件拿到 agent 的产出
  expect(readFileSync(join(repo, 'file.txt'), 'utf-8')).toContain('hello from dispatch')

  db.close()
  rmSync(home, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
}

describe('真实 agent CLI 实机联调(RUN_REAL_AGENTS 按名启用)', () => {
  for (const agent of AGENT_IDS) {
    it.skipIf(!requested.includes(agent))(
      `${agent}: 立即执行 → 两阶段产物 → 自动合并回 base`,
      { timeout: 10 * 60_000 },
      async () => {
        await runRealAgent(agent)
      }
    )
  }
})
