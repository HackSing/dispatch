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
})
