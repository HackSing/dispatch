import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentConfigSchema, type AgentConfig } from '@core/config'
import { getPlatformOps } from '@core/platform'
import { GenericCliAdapter } from '@core/agents/generic-cli-adapter'

const MOCK_SCRIPT = fileURLToPath(new URL('./fixtures/mock-agent.cjs', import.meta.url))

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dispatch-adapter-'))
})

afterEach(() => {
  delete process.env.MOCK_MODE
  rmSync(dir, { recursive: true, force: true })
})

function makeAdapter(config: Partial<AgentConfig> = {}): GenericCliAdapter {
  return new GenericCliAdapter(
    'claude-code',
    AgentConfigSchema.parse({ bin: process.execPath, headless_args: [MOCK_SCRIPT], ...config }),
    getPlatformOps(),
    { readyTimeoutMs: 3000, readyPollMs: 20 }
  )
}

describe('run', () => {
  it('prompt_via=stdin:提示词写入 stdin,产物落 outDir,日志逐 chunk 回调', async () => {
    process.env.MOCK_MODE = 'success'
    const logs: string[] = []
    const adapter = makeAdapter({ prompt_via: 'stdin' })
    const { exitCode } = await adapter.run({
      prompt: `OUT_DIR: ${dir}\n任务原文`,
      cwd: dir,
      outDir: dir,
      timeoutMs: 60_000,
      onLog: (c) => logs.push(c)
    })
    expect(exitCode).toBe(0)
    expect(existsSync(join(dir, 'plan.md'))).toBe(true)
    expect(existsSync(join(dir, 'result.json'))).toBe(true)
    expect(logs.join('')).toContain('mock-agent: mode=success')
  })

  it('signal abort → killTree 并以 exitCode=-1 归还', async () => {
    process.env.MOCK_MODE = 'hang'
    const adapter = makeAdapter()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 200)
    const { exitCode } = await adapter.run({
      prompt: `OUT_DIR: ${dir}\n`,
      cwd: dir,
      outDir: dir,
      timeoutMs: 60_000,
      onLog: () => {},
      signal: controller.signal
    })
    expect(exitCode).toBe(-1)
    const pid = Number(readFileSync(join(dir, 'mock.pid'), 'utf-8'))
    expect(() => process.kill(pid, 0)).toThrow()
  }, 15_000)

  it('bin 不存在 → 明确报错而非静默', async () => {
    const adapter = new GenericCliAdapter(
      'claude-code',
      AgentConfigSchema.parse({ bin: '/nonexistent/bin/agent-x' }),
      getPlatformOps()
    )
    await expect(
      adapter.run({ prompt: 'x', cwd: dir, outDir: dir, timeoutMs: 1000, onLog: () => {} })
    ).rejects.toThrow(/启动失败/)
  })
})

describe('ensureReady', () => {
  it('无 ready_check_cmd 直接就绪', async () => {
    await expect(makeAdapter().ensureReady()).resolves.toBeUndefined()
  })

  it('ready_check 失败时执行 start_cmd 并轮询至就绪', async () => {
    const flag = join(dir, 'daemon-flag')
    const adapter = makeAdapter({
      ready_check_cmd: `test -f ${flag}`,
      start_cmd: `sleep 0.1 && touch ${flag}`
    })
    await expect(adapter.ensureReady()).resolves.toBeUndefined()
    expect(existsSync(flag)).toBe(true)
  })

  it('ready_check 失败且无 start_cmd → 抛错', async () => {
    const adapter = makeAdapter({ ready_check_cmd: 'exit 1' })
    await expect(adapter.ensureReady()).rejects.toThrow(/start_cmd/)
  })

  it('start 后超时未就绪 → 抛错', async () => {
    const adapter = makeAdapter({ ready_check_cmd: 'exit 1', start_cmd: 'true' })
    await expect(adapter.ensureReady()).rejects.toThrow(/未就绪/)
  }, 10_000)
})

describe('detect', () => {
  it('bin 不存在 → ok=false 且带原因', async () => {
    const adapter = new GenericCliAdapter(
      'claude-code',
      AgentConfigSchema.parse({ bin: 'dispatch-nonexistent-bin' }),
      getPlatformOps()
    )
    const r = await adapter.detect()
    expect(r.ok).toBe(false)
    expect(r.failReason).toContain('dispatch-nonexistent-bin')
  })

  it('git 作为样本二进制可通过两级检测', async () => {
    const adapter = new GenericCliAdapter(
      'claude-code',
      AgentConfigSchema.parse({ bin: 'git' }),
      getPlatformOps()
    )
    const r = await adapter.detect()
    expect(r.ok).toBe(true)
    expect(r.version).toContain('git version')
  })
})
