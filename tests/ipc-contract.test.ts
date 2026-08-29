import { describe, expect, it } from 'vitest'
import { INVOKE_CHANNELS, EVENT_CHANNELS, type InvokeChannel } from '@shared/ipc'

/**
 * IPC 契约(方案确认闸批次 3):新频道必须同时登记进 InvokeMap(类型,tsc 保证)与 INVOKE_CHANNELS(运行时白名单)。
 * preload 从 INVOKE_CHANNELS 派生放行名单,漏登记会让渲染层拿不到通道——本测试守 INVOKE_CHANNELS 侧。
 */

const NEW_INVOKE_CHANNELS = [
  'task:confirm-plan',
  'task:plan-discuss-open',
  'task:plan-discuss-send',
  'task:plan-discuss-close'
] as const

describe('方案确认闸 IPC 契约', () => {
  it('四个新 invoke 频道都登记进 INVOKE_CHANNELS(preload 白名单来源)', () => {
    for (const ch of NEW_INVOKE_CHANNELS) {
      expect(INVOKE_CHANNELS).toContain(ch)
      // 类型侧:能赋给 InvokeChannel 即证明 InvokeMap 也已登记(tsc 编译期保证)
      const typed: InvokeChannel = ch
      expect(typed).toBe(ch)
    }
  })

  it('INVOKE_CHANNELS 无重复(防复制粘贴漏改)', () => {
    expect(new Set(INVOKE_CHANNELS).size).toBe(INVOKE_CHANNELS.length)
  })

  it('EventMap 复用 task:session-event,不新增事件频道', () => {
    expect(EVENT_CHANNELS).toContain('task:session-event')
    // 讨论会话不引入新事件频道
    expect(EVENT_CHANNELS).not.toContain('task:plan-discuss-event')
  })
})
