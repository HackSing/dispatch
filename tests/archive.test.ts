import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createArchive, OutputLog } from '@core/archive'
import { readTaskArchive } from '@core/archive/read'
import { ensureDispatchDirs, resolvePaths, type DispatchPaths } from '@core/paths'
import type { Project, Task } from '@shared/types'

let home: string
let paths: DispatchPaths

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dispatch-archive-'))
  paths = resolvePaths(home)
  ensureDispatchDirs(paths)
})

afterEach(() => rmSync(home, { recursive: true, force: true }))

const project: Project = {
  id: 'p1',
  name: 'demo',
  path: '/tmp/demo',
  prepareCmd: null,
  baseBranch: null,
  createdAt: '2026-08-22T00:00:00Z'
}

function fakeTask(): Task {
  return {
    id: 'aabbccdd-0000-0000-0000-000000000000',
    createdAt: '2026-08-22T00:00:00Z',
    text: 'x',
    projectId: 'p1',
    agent: 'claude-code',
    subAgent: null,
    triggerType: 'immediate',
    triggerAt: null,
    status: 'running',
    phase: null,
    reviewRound: 0,
    sessionId: null,
    parentTaskId: null,
    baseBranch: null,
    branch: null,
    worktreePath: null,
    archiveDir: null,
    failReason: null,
    scheduledAt: null,
    startedAt: null,
    finishedAt: null,
    mergedAt: null
  }
}

describe('createArchive 撞名', () => {
  it('同任务同日重复执行(原地重跑)得到 -2/-3 后缀目录,不复用旧目录', () => {
    const now = new Date('2026-08-22T10:00:00')
    const first = createArchive(paths, project, fakeTask(), { vcs: 'git', now })
    const second = createArchive(paths, project, fakeTask(), { vcs: 'git', now })
    const third = createArchive(paths, project, fakeTask(), { vcs: 'git', now })
    expect(second.archiveDir).toBe(`${first.archiveDir}-2`)
    expect(third.archiveDir).toBe(`${first.archiveDir}-3`)
    for (const info of [first, second, third]) {
      expect(existsSync(info.taskMdFile)).toBe(true)
    }
  })
})

describe('OutputLog 文件名参数 + discussion.log 读取', () => {
  it('缺省写 output.log,传 discussion.log 时写同名文件', async () => {
    const dir = mkdtempSync(join(home, 'log-'))
    const out = new OutputLog(dir)
    out.append('exec line\n')
    await out.close()
    const discuss = new OutputLog(dir, 'discussion.log')
    discuss.append('[user] 讨论一句\n')
    await discuss.close()
    expect(readFileSync(join(dir, 'output.log'), 'utf-8')).toBe('exec line\n')
    expect(readFileSync(join(dir, 'discussion.log'), 'utf-8')).toBe('[user] 讨论一句\n')
  })

  it('readTaskArchive 追加 discussionLog:有则读尾部,无则 null', async () => {
    const dir = mkdtempSync(join(home, 'archive-'))
    // 无 discussion.log
    expect(readTaskArchive(dir).discussionLog).toBeNull()
    // 写入后读到尾部
    const log = new OutputLog(dir, 'discussion.log')
    log.append('===== 讨论轮 1 =====\n[user] 改细第 2 步\necho:好的\n')
    await log.close()
    expect(readTaskArchive(dir).discussionLog).toContain('[user] 改细第 2 步')
    // 归档目录不存在时全 null(含 discussionLog)
    expect(readTaskArchive(null).discussionLog).toBeNull()
  })
})
