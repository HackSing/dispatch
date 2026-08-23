/**
 * DispatchApi 的浏览器实现:与 preload 同形(invoke/on),组件层零感知。
 * invoke → POST /api/dispatch/invoke/<channel>;事件 → EventSource SSE 具名分发。
 * capture:hide 为壳专属,在此本地拦截为模态层回调,不打到 host。
 * project:pick-directory 三级串联:先 HTTP 透传(宿主 native 系统对话框,
 * 仅本机部署形态有),宿主返回 not_supported(browse/缺失)落回面板模态回调
 * (options.pickDirectory,模态自身已含 browse → 手输串联);其余错误原样抛。
 *
 * @module dsh-dispatch/client/api-bridge
 */
import { EVENT_CHANNELS } from '@shared/ipc'
import type { DispatchApi, EventChannel, InvokeChannel, InvokeMap } from '@shared/ipc'

type Listener = (payload: any) => void

export interface BridgeOptions {
  onCaptureHide?: () => void
  /** 宿主无 native 目录选择能力时的降级交互,由 panel 提供(模态自身已含 browse → 手输串联) */
  pickDirectory?: () => Promise<string | null>
}

/**
 * 通用 HTTP invoke:POST 透传并解包 {ok} 信封。业务失败抛带 code 的 Error
 * (message 已是 `${message}(${code})` 展示格式);供通用路径与 pick-directory 串联共用。
 */
async function invokeHttp(channel: InvokeChannel, payload: unknown): Promise<unknown> {
  const res = await fetch(`/api/dispatch/invoke/${encodeURIComponent(channel)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload === undefined || payload === null ? '' : JSON.stringify(payload),
  })
  const body = (await res.json()) as { ok: boolean; value?: unknown; error?: { code: string; message: string } }
  if (!body.ok) {
    throw body.error
      ? Object.assign(new Error(`${body.error.message}(${body.error.code})`), { code: body.error.code })
      : new Error(`invoke ${channel} 失败: HTTP ${res.status}`)
  }
  return body.value
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
      // 三级串联第一级:宿主 native 系统对话框;not_supported(browse/缺失)落回面板模态,其余错误原样抛
      try {
        return (await invokeHttp(channel, payload)) as InvokeMap[C]['res']
      } catch (cause) {
        if ((cause as { code?: string }).code !== 'not_supported') throw cause
      }
      // 不做静默兜底:缺回调直接抛错,由调用方的错误呈现通道暴露
      if (options.pickDirectory === undefined) {
        throw new Error('插件形态目录选择需要面板提供 pickDirectory 回调(window.prompt 在 Electron 渲染进程不可用)')
      }
      return (await options.pickDirectory()) as InvokeMap[C]['res']
    }
    return (await invokeHttp(channel, payload)) as InvokeMap[C]['res']
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
