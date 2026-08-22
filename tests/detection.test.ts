import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openDatabase, DetectionStore } from '@core/db'
import { AgentConfigSchema } from '@core/config'
import { detectAgent, runDetections } from '@core/agents/detection'
import type { PlatformOps } from '@core/platform'

let dir: string
let db: Database

/** findBinary 以脚本文件模拟,不依赖本机 PATH 上装了什么 */
function fakeOps(bins: Record<string, string>): PlatformOps {
  return {
    killTree: () => Promise.resolve(),
    findBinary: (name) => Promise.resolve(bins[name] ?? null)
  }
}

function makeScript(name: string, body: string): string {
  const file = join(dir, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dispatch-detect-'))
  db = openDatabase(join(dir, 'test.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('detectAgent 两级检测', () => {
  it('二进制不存在:一级失败,原因含 bin 名', async () => {
    const config = AgentConfigSchema.parse({ bin: 'ghost' })
    const result = await detectAgent(config, fakeOps({}))
    expect(result.ok).toBe(false)
    expect(result.failReason).toContain('ghost')
  })

  it('version 正常退出:ok 并取首行为版本', async () => {
    const bin = makeScript('fake-agent', 'echo fake 1.2.3\necho extra')
    const config = AgentConfigSchema.parse({ bin: 'fake-agent' })
    const result = await detectAgent(config, fakeOps({ 'fake-agent': bin }))
    expect(result).toEqual({ ok: true, version: 'fake 1.2.3' })
  })

  it('version 非零退出:二级失败,原因含退出码', async () => {
    const bin = makeScript('broken-agent', 'exit 2')
    const config = AgentConfigSchema.parse({ bin: 'broken-agent' })
    const result = await detectAgent(config, fakeOps({ 'broken-agent': bin }))
    expect(result.ok).toBe(false)
    expect(result.failReason).toContain('退出码 2')
  })

  it('version 超时:失败并注明超时', async () => {
    const bin = makeScript('slow-agent', 'sleep 5')
    const config = AgentConfigSchema.parse({ bin: 'slow-agent' })
    const result = await detectAgent(config, fakeOps({ 'slow-agent': bin }), 300)
    expect(result.ok).toBe(false)
    expect(result.failReason).toContain('超时')
  })
})

describe('runDetections 结果落库', () => {
  it('逐 agent upsert,重复检测不增行且状态可翻转', async () => {
    const store = new DetectionStore(db)
    const okBin = makeScript('claude', 'echo claude 2.0')
    const agents = {
      'claude-code': AgentConfigSchema.parse({ bin: 'claude' }),
      codex: AgentConfigSchema.parse({ bin: 'codex' })
    }

    const first = await runDetections(agents, fakeOps({ claude: okBin }), store)
    expect(first).toHaveLength(2)
    expect(store.get('claude-code')).toMatchObject({ ok: true, version: 'claude 2.0' })
    expect(store.get('codex')).toMatchObject({ ok: false })
    expect(store.get('codex')?.failReason).toContain('codex')

    // 第二次检测 codex 出现了:同一行翻转为 ok,不新增行
    const codexBin = makeScript('codex', 'echo codex 0.9')
    const second = await runDetections(agents, fakeOps({ claude: okBin, codex: codexBin }), store)
    expect(second).toHaveLength(2)
    expect(store.get('codex')).toMatchObject({ ok: true, version: 'codex 0.9' })
  })

  it('config.agents 中的未知 key 不参与检测', async () => {
    const store = new DetectionStore(db)
    const agents = { 'not-an-agent': AgentConfigSchema.parse({ bin: 'x' }) }
    const list = await runDetections(agents, fakeOps({}), store)
    expect(list).toHaveLength(0)
  })
})
