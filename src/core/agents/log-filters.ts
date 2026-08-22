/**
 * 日志过滤器:把 agent CLI 的机器格式输出转成人可读的执行日志。
 * 经 AgentConfig.log_filter 按名启用,与 agent id 无关(spec §5.2 配置驱动原则)。
 * claude_stream_json 的事件形状依 2026-08-22 对 claude 2.1.229 的实测样本。
 */

export interface LogFilter {
  transform(chunk: string): string
  /** 进程结束时调用,吐出缓冲中未换行的残段 */
  flush(): string
}

const identity: LogFilter = {
  transform: (chunk) => chunk,
  flush: () => ''
}

function summarizeToolInput(input: unknown): string {
  const s = JSON.stringify(input) ?? ''
  return s.length > 160 ? s.slice(0, 160) + '…' : s
}

interface StreamEvent {
  type?: string
  subtype?: string
  cwd?: string
  message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> }
  is_error?: boolean
  num_turns?: number
  total_cost_usd?: number
}

function renderEvent(line: string): string {
  let event: StreamEvent
  try {
    event = JSON.parse(line) as StreamEvent
  } catch {
    return line + '\n' // 非 JSON 行(告警等)原样保留
  }
  if (event.type === 'system' && event.subtype === 'init') {
    return `▶ 会话开始 cwd=${event.cwd ?? '?'}\n`
  }
  if (event.type === 'assistant' && event.message?.content) {
    let out = ''
    for (const block of event.message.content) {
      if (block.type === 'text' && block.text?.trim()) out += block.text.trim() + '\n'
      if (block.type === 'tool_use') {
        out += `[工具] ${block.name ?? '?'} ${summarizeToolInput(block.input)}\n`
      }
    }
    return out
  }
  // 结果行:部分版本无 type 字段,以 is_error/total_cost_usd 识别
  if (event.type === 'result' || (event.type === undefined && event.is_error !== undefined)) {
    const cost = event.total_cost_usd !== undefined ? ` cost=$${event.total_cost_usd.toFixed(4)}` : ''
    return `■ 会话结束 turns=${event.num_turns ?? '?'}${cost}${event.is_error ? ' [出错]' : ''}\n`
  }
  // hook/rate_limit/user(工具结果)等噪音事件不入日志
  return ''
}

function createClaudeStreamJsonFilter(): LogFilter {
  let buffer = ''
  return {
    transform(chunk: string): string {
      buffer += chunk
      let out = ''
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (line) out += renderEvent(line)
      }
      return out
    },
    flush(): string {
      const rest = buffer.trim()
      buffer = ''
      return rest ? renderEvent(rest) : ''
    }
  }
}

export const LOG_FILTER_NAMES = ['claude_stream_json'] as const
export type LogFilterName = (typeof LOG_FILTER_NAMES)[number]

export function createLogFilter(name: LogFilterName | null | undefined): LogFilter {
  if (name === 'claude_stream_json') return createClaudeStreamJsonFilter()
  return identity
}
