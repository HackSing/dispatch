import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '@core/config'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dispatch-config-'))
  file = join(dir, 'config.json')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('config', () => {
  it('文件缺失时生成默认配置并落盘', () => {
    const config = loadConfig(file)
    expect(existsSync(file)).toBe(true)
    expect(config.max_concurrency).toBe(2)
    expect(config.missed_task_policy).toBe('run')
    expect(config.daily_report_notify).toBe(true)
    expect(config.agents['claude-code'].bin).toBe('claude')
    expect(config.agents['claude-code'].headless_args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose'
    ])
    expect(config.agents['claude-code'].log_filter).toBe('claude_stream_json')
    // 落盘的文件可直接二次加载
    expect(loadConfig(file)).toEqual(config)
  })

  it('用户覆盖项生效,缺省项补默认', () => {
    writeFileSync(file, JSON.stringify({ max_concurrency: 4 }))
    const config = loadConfig(file)
    expect(config.max_concurrency).toBe(4)
    expect(config.task_timeout_min).toBe(30)
  })

  it('损坏 JSON 抛 ConfigError,不覆盖用户文件', () => {
    writeFileSync(file, '{ broken')
    expect(() => loadConfig(file)).toThrow(ConfigError)
    expect(readFileSync(file, 'utf-8')).toBe('{ broken')
  })

  it('非法取值抛 ConfigError', () => {
    writeFileSync(file, JSON.stringify({ missed_task_policy: 'yolo' }))
    expect(() => loadConfig(file)).toThrow(ConfigError)
  })

  it('会话三件套:claude-code 默认已校准,其余 agent 留空即不支持', () => {
    const config = loadConfig(file)
    const claude = config.agents['claude-code']
    expect(claude.session_args).toEqual(['--session-id', '{SESSION_ID}'])
    expect(claude.resume_headless_args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--resume',
      '{SESSION_ID}'
    ])
    expect(claude.interactive_resume_cmd).toBe('claude --resume {SESSION_ID}')
    for (const id of ['codex', 'dsh', 'kimi', 'qwen'] as const) {
      expect(config.agents[id].session_args).toEqual([])
      expect(config.agents[id].resume_headless_args).toEqual([])
      expect(config.agents[id].interactive_resume_cmd).toBeNull()
    }
  })

  it('用户已有 config.json 无会话字段时按默认吸收(向后兼容)', () => {
    writeFileSync(
      file,
      JSON.stringify({ agents: { 'claude-code': { bin: 'claude', headless_args: ['-p'] } } })
    )
    const config = loadConfig(file)
    // 用户显式给出的 agent 条目缺新字段 → zod default 补空,功能按能力隐藏而非报错
    expect(config.agents['claude-code'].session_args).toEqual([])
    expect(config.agents['claude-code'].interactive_resume_cmd).toBeNull()
  })
})
