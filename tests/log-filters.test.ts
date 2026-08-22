import { describe, expect, it } from 'vitest'
import { createLogFilter } from '@core/agents/log-filters'

/** 事件样本取自 2026-08-22 对本机 claude 2.1.229 的实测(--output-format stream-json --verbose) */
const INIT = '{"type":"system","subtype":"init","cwd":"/tmp/probe","session_id":"s1"}'
const HOOK = '{"type":"system","subtype":"hook_started","hook_name":"SessionStart:startup"}'
const RATE = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}'
const TEXT =
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"你好"}]}}'
const TOOL =
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}'
const RESULT = '{"is_error":false,"duration_api_ms":1623,"num_turns":1,"total_cost_usd":0.0898}'

describe('createLogFilter', () => {
  it('null → 原样透传', () => {
    const f = createLogFilter(null)
    expect(f.transform('raw chunk')).toBe('raw chunk')
    expect(f.flush()).toBe('')
  })

  it('claude_stream_json:init/文本/工具可读化,噪音事件丢弃', () => {
    const f = createLogFilter('claude_stream_json')
    const out = f.transform([HOOK, INIT, TEXT, TOOL, RATE, RESULT].join('\n') + '\n')
    expect(out).toContain('▶ 会话开始 cwd=/tmp/probe')
    expect(out).toContain('你好')
    expect(out).toContain('[工具] Bash {"command":"ls"}')
    expect(out).toContain('■ 会话结束 turns=1 cost=$0.0898')
    expect(out).not.toContain('hook_started')
    expect(out).not.toContain('rate_limit')
  })

  it('跨 chunk 断行正确缓冲,flush 吐出残段', () => {
    const f = createLogFilter('claude_stream_json')
    const mid = TEXT.length >> 1
    expect(f.transform(TEXT.slice(0, mid))).toBe('')
    expect(f.transform(TEXT.slice(mid) + '\n')).toBe('你好\n')
    expect(f.transform(RESULT)).toBe('') // 无换行,留在缓冲
    expect(f.flush()).toContain('■ 会话结束')
  })

  it('非 JSON 行(告警等)原样保留', () => {
    const f = createLogFilter('claude_stream_json')
    expect(f.transform('Warning: something\n')).toBe('Warning: something\n')
  })
})
