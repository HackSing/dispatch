/**
 * DispatchApi 的浏览器实现:与 preload 同形(invoke/on),组件层零感知。
 * invoke → POST /api/dispatch/invoke/<channel>;事件 → EventSource SSE 具名分发。
 * 两个壳专属通道在此本地拦截,不打到 host:
 *   project:pick-directory → window.prompt(浏览器无法枚举本地目录)
 *   capture:hide          → 模态层回调
 *
 * @module dsh-dispatch/client/api-bridge
 */
import { EVENT_CHANNELS } from '@shared/ipc'
import type { DispatchApi, EventChannel, InvokeChannel, InvokeMap } from '@shared/ipc'

type Listener = (payload: any) => void

export interface BridgeOptions {
  onCaptureHide?: () => void
}

export function createApiBridge(options: BridgeOptions = {}): DispatchApi {
  const listeners = new Map<EventChannel, Set<Listener>>()
  let source: EventSource | null = null

  function ensureSource(): void {
    if (source) return
    source = new EventSource('/api/dispatch/events')
    for (const channel of EVENT_CHANNELS) {
      source.addEventListener(channel, (ev) => {
        let payload: unknown = null
        try {
          payload = JSON.parse((ev as MessageEvent).data)
        } catch {
          payload = null
        }
        for (const fn of listeners.get(channel) ?? []) fn(payload)
      })
    }
  }

  async function invoke<C extends InvokeChannel>(channel: C, payload: InvokeMap[C]['req']): Promise<InvokeMap[C]['res']> {
    if (channel === 'capture:hide') {
      options.onCaptureHide?.()
      return undefined as InvokeMap[C]['res']
    }
    if (channel === 'project:pick-directory') {
      return promptDirectory() as InvokeMap[C]['res']
    }
    const res = await fetch(`/api/dispatch/invoke/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload === undefined || payload === null ? '' : JSON.stringify(payload),
    })
    const body = (await res.json()) as { ok: boolean; value?: unknown; error?: { code: string; message: string } }
    if (!body.ok) {
      throw new Error(body.error ? `${body.error.message}(${body.error.code})` : `invoke ${channel} 失败: HTTP ${res.status}`)
    }
    return body.value as InvokeMap[C]['res']
  }

  function on<C extends EventChannel>(channel: C, listener: (payload: any) => void): () => void {
    ensureSource()
    const set = listeners.get(channel) ?? new Set()
    set.add(listener)
    listeners.set(channel, set)
    return () => {
      set.delete(listener)
    }
  }

  return { invoke, on } as DispatchApi
}

/** 浏览器拿不到目录枚举,prompt 手输绝对路径;取消返回 null(与对话框语义一致) */
function promptDirectory(): string | null {
  const input = window.prompt('输入项目文件夹的绝对路径(插件形态不支持系统目录选择):')
  return input && input.trim() ? input.trim() : null
}
