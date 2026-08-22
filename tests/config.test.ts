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

  it('旧 config.json 吸收新默认:缺失键补齐、空值升级、用户非空值不动,且回写落盘', () => {
    writeFileSync(
      file,
      JSON.stringify({
        agents: {
          // 缺全部会话字段(旧快照)→ 补当前默认;用户改过的 headless_args 非空 → 保留
          'claude-code': { bin: 'claude', headless_args: ['-p', '--custom'] },
          // 旧默认快照的空 headless_args + 无 log_filter → 吸收 stream 校准值
          qwen: { bin: 'qwen', headless_args: [], prompt_via: 'stdin' }
        }
      })
    )
    const config = loadConfig(file)
    expect(config.agents['claude-code'].headless_args).toEqual(['-p', '--custom'])
    expect(config.agents['claude-code'].session_args).toEqual(['--session-id', '{SESSION_ID}'])
    expect(config.agents['claude-code'].interactive_resume_cmd).toBe('claude --resume {SESSION_ID}')
    expect(config.agents['qwen'].headless_args).toEqual(['-o', 'stream-json'])
    expect(config.agents['qwen'].log_filter).toBe('claude_stream_json')
    // 缺失的 agent 条目整体补齐
    expect(config.agents['codex'].bin).toBe('codex')
    // 吸收结果已回写:二次加载不再变更且内容一致
    const reloaded = loadConfig(file)
    expect(reloaded).toEqual(config)
    const onDisk = JSON.parse(readFileSync(file, 'utf-8'))
    expect(onDisk.agents['claude-code'].session_args).toEqual(['--session-id', '{SESSION_ID}'])
  })
})
