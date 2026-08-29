import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentId, Task } from '@shared/types'
import { openDatabase, TaskStore, ProjectStore } from '@core/db'
import { ensureDispatchDirs, resolvePaths } from '@core/paths'
import { ConfigSchema } from '@core/config'
import { GenericCliAdapter } from '@core/agents/generic-cli-adapter'
import { getPlatformOps } from '@core/platform'
import { runTask, Semaphore, KeyedLock, type ExecutorDeps } from '@core/executor'
import { FollowUpSession } from '@core/executor/follow-up'
import { makeGitRepo } from './fixtures/git-repo'

/**
 * L3 实机门控(Plan interaction-batch-v03 / Acceptance c2):真实 Claude Code 会话面板
 * 全链路——暗号法证明接力轮与原任务同 session,两轮后完成合并。
 * 消耗真实 agent 配额,默认跳过:RUN_REAL_AGENTS 含 claude-code 时启用。
 */
const enabled = (process.env.RUN_REAL_AGENTS ?? '').split(',').includes('claude-code')

const CODEWORD = 'papaya77'

describe.skipIf(!enabled)('真实 Claude Code 会话面板门控', () => {
  it('done 任务 → 面板两轮(暗号连续)→ 完成合并', { timeout: 15 * 60_000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), 'dispatch-real-fu-'))
    const paths = resolvePaths(home)
    ensureDispatchDirs(paths)
    const db = openDatabase(paths.dbFile)
    const tasks = new TaskStore(db)
    const projects = new ProjectStore(db)
    const config = ConfigSchema.parse({})
    const repo = makeGitRepo('dispatch-real-fu-repo-')
    const project = projects.create({ name: 'real-fu', path: repo })
    const promptsDir = resolve(__dirname, '../resources/prompts')

    const deps: ExecutorDeps = {
      tasks,
      projects,
      config,
      paths,
      adapterFor: (agent: AgentId) =>
        new GenericCliAdapter(agent, config.agents[agent], getPlatformOps()),
      semaphore: new Semaphore(1),
      mergeLocks: new KeyedLock(),
      builtinPromptFile: join(promptsDir, 'default.md'),
      builtinPromptsDir: promptsDir
    }

    try {
      // ① 常规任务真实执行:预生成 session id 随 fresh run 落库
      const seed = tasks.create({
        text:
          `在仓库根目录的 file.txt 末尾追加一行文本:hello from dispatch。` +
          `另外记住本任务的暗号是 ${CODEWORD},后续会话会问你。不要改动其他文件。`,
        projectId: project.id,
        agent: 'claude-code',
        triggerType: 'immediate'
      })
      // 方案确认闸两跑:方案跑停 awaiting_confirm → 确认放行 → 执行跑合并 done
      const paused = await runTask(deps, seed.id)
      expect(paused.status).toBe('awaiting_confirm')
      tasks.transition(seed.id, 'scheduled', {})
      const parent = await runTask(deps, seed.id)
      expect(parent.status).toBe('done')
      expect(parent.sessionId).toMatch(/^[0-9a-f-]{36}$/)

      // ② 面板会话:两轮同 session
      const closed: string[] = []
      const session = await FollowUpSession.start(deps, parent.id, {
        onRoundStart() {},
        onChunk() {},
        onRoundResult() {},
        onClosed: (_t, reason) => closed.push(reason)
      })
      await session.sendTurn(
        '本会话此前的暗号是什么?把暗号原文写入仓库根目录新文件 code.txt(只写暗号一行),然后在回答里也说出暗号。'
      )
      const codeFile = join(session.workingDir, 'code.txt')
      expect(existsSync(codeFile)).toBe(true)
      // 暗号只存在于原任务会话:写对即证明 resume 的是同一个 session
      expect(readFileSync(codeFile, 'utf-8')).toContain(CODEWORD)

      await session.sendTurn('在 code.txt 追加第二行:round2-ok,不要改其他内容。')
      expect(readFileSync(codeFile, 'utf-8')).toContain('round2-ok')

      // ③ 完成合并:改动回到主检出,归档含逐轮记录
      const done = await session.finish()
      expect(done.status).toBe('done')
      expect(done.mergedAt).not.toBeNull()
      const merged = readFileSync(join(repo, 'code.txt'), 'utf-8')
      expect(merged).toContain(CODEWORD)
      expect(merged).toContain('round2-ok')
      const followTask = tasks.get(session.taskId) as Task
      const rounds = readFileSync(join(followTask.archiveDir as string, 'rounds.jsonl'), 'utf-8')
        .trim()
        .split('\n')
      expect(rounds).toHaveLength(2)
      expect(closed).toEqual(['finished'])
    } finally {
      db.close()
      rmSync(home, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
