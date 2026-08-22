import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentId } from '@shared/types'
import { openDatabase, TaskStore, ProjectStore } from '@core/db'
import { ensureDispatchDirs, resolvePaths } from '@core/paths'
import { ConfigSchema } from '@core/config'
import { GenericCliAdapter } from '@core/agents/generic-cli-adapter'
import { getPlatformOps } from '@core/platform'
import { runTask, Semaphore, KeyedLock, type ExecutorDeps } from '@core/executor'
import { makeGitRepo } from './fixtures/git-repo'

/**
 * L3 实机联调:真实 Claude Code + 真模板 + 真 git 仓库,验证 B2 全链路。
 * 消耗真实 agent 配额且依赖本机 claude 登录态,默认跳过,RUN_REAL_CLAUDE=1 启用。
 */
const enabled = process.env.RUN_REAL_CLAUDE === '1'

describe.skipIf(!enabled)('真实 Claude Code 实机联调', () => {
  it('立即执行 → 两阶段产物 → 自动合并回 base', { timeout: 10 * 60_000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), 'dispatch-real-'))
    const paths = resolvePaths(home)
    ensureDispatchDirs(paths)
    const db = openDatabase(paths.dbFile)
    const tasks = new TaskStore(db)
    const projects = new ProjectStore(db)
    const config = ConfigSchema.parse({})
    const repo = makeGitRepo('dispatch-real-repo-')
    const project = projects.create({ name: 'real', path: repo })
    const task = tasks.create({
      text: '在仓库根目录的 file.txt 末尾追加一行文本:hello from dispatch。不要改动其他文件。',
      projectId: project.id,
      agent: 'claude-code',
      triggerType: 'immediate'
    })

    const deps: ExecutorDeps = {
      tasks,
      projects,
      config,
      paths,
      adapterFor: (agent: AgentId) => new GenericCliAdapter(agent, config.agents[agent], getPlatformOps()),
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
  })
})
