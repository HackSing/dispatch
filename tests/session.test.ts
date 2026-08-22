import { describe, expect, it } from 'vitest'
import { AgentConfigSchema } from '@core/config'
import {
  buildBaseArgs,
  renderSessionArgs,
  supportsResume,
  supportsSession,
  supportsTerminalResume
} from '@core/agents/session'

const SID = '03a02743-6603-4360-9859-a0669170d8ab'

function config(overrides: object = {}) {
  return AgentConfigSchema.parse({ bin: 'agent', ...overrides })
}

describe('renderSessionArgs', () => {
  it('替换全部 {SESSION_ID} 占位,非占位参数原样透传', () => {
    expect(renderSessionArgs(['--session-id', '{SESSION_ID}', '-p'], SID)).toEqual([
      '--session-id',
      SID,
      '-p'
    ])
  })

  it('模板含占位但未提供 sessionId 抛错(调用方契约违约)', () => {
    expect(() => renderSessionArgs(['--resume', '{SESSION_ID}'])).toThrow('SESSION_ID')
  })

  it('无占位时缺 sessionId 合法(不支持会话的 agent 正常路径)', () => {
    expect(renderSessionArgs(['-p'])).toEqual(['-p'])
  })
})

describe('buildBaseArgs', () => {
  const claudeLike = config({
    headless_args: ['-p', '--verbose'],
    session_args: ['--session-id', '{SESSION_ID}'],
    resume_headless_args: ['-p', '--resume', '{SESSION_ID}']
  })

  it('fresh run:session_args 渲染后前置于 headless_args(保住 prompt-flag-最后 约束)', () => {
    expect(buildBaseArgs('claude-code', claudeLike, { sessionId: SID })).toEqual([
      '--session-id',
      SID,
      '-p',
      '--verbose'
    ])
  })

  it('fresh run:session_args 为空时不要求 sessionId,argv 与既有行为一致', () => {
    expect(buildBaseArgs('kimi', config({ headless_args: ['--prompt'] }), {})).toEqual(['--prompt'])
  })

  it('resume run:resume_headless_args 整体替换 headless_args', () => {
    expect(buildBaseArgs('claude-code', claudeLike, { resume: true, sessionId: SID })).toEqual([
      '-p',
      '--resume',
      SID
    ])
  })

  it('resume run:未配置 resume_headless_args 抛错', () => {
    expect(() => buildBaseArgs('qwen', config(), { resume: true, sessionId: SID })).toThrow(
      'resume_headless_args'
    )
  })
})

describe('会话能力判定', () => {
  it('三级能力由配置三件套单点决定', () => {
    const none = config()
    expect(supportsSession(none)).toBe(false)
    expect(supportsResume(none)).toBe(false)
    expect(supportsTerminalResume(none)).toBe(false)

    const sessionOnly = config({ session_args: ['--session-id', '{SESSION_ID}'] })
    expect(supportsSession(sessionOnly)).toBe(true)
    expect(supportsResume(sessionOnly)).toBe(false)

    const full = config({
      session_args: ['--session-id', '{SESSION_ID}'],
      resume_headless_args: ['--resume', '{SESSION_ID}'],
      interactive_resume_cmd: 'agent --resume {SESSION_ID}'
    })
    expect(supportsResume(full)).toBe(true)
    expect(supportsTerminalResume(full)).toBe(true)
  })
})
