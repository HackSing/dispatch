/**
 * 会话面板传输层(Plan interaction-batch-v03):同一 worktree 内逐轮送话。
 * - StreamTransport:常驻进程,stdin 写 user NDJSON,stdout 为 stream-json 事件流
 *   (线格式与 log_filter=claude_stream_json 相同,解析复用 log-filters,不平行再写);
 * - RoundSpawnTransport:每轮以 resume_headless_args spawn 一次,薄包装 AgentAdapter.run。
 * 两者均零 agent 分支:行为完全由 AgentConfig 模板驱动(spec §5.2)。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import type { AgentConfig } from '@core/config'
import type { PlatformOps } from '@core/platform'
import {
  isResultStreamEvent,
  LineBuffer,
  parseStreamEvent,
  renderStreamEvent,
  type StreamEvent
} from './log-filters'
import { renderSessionArgs } from './session'
import type { AgentAdapter } from './types'

export interface RoundResult {
  durationMs: number
  costUsd: number | null
  isError: boolean
}

/** 轮超时:传输已自行关闭,会话不可再用,引擎据此落 failed(timeout_round) */
export class RoundTimeoutError extends Error {
  constructor() {
    super('轮次超时,会话已终止')
    this.name = 'RoundTimeoutError'
  }
}

/** 轮进行中进程退出:引擎据此落 failed(session_exit_<code>) */
export class SessionExitError extends Error {
  constructor(public readonly exitCode: number | null) {
    super(`会话进程退出(code=${exitCode ?? 'null'})`)
    this.name = 'SessionExitError'
  }
}

export interface SessionTransport {
  open(): Promise<void>
  /** 串行:上一轮未结束时调用抛错;超时抛 RoundTimeoutError 且传输随之关闭 */
  sendTurn(text: string, timeoutMs: number): Promise<RoundResult>
  /** 幂等;关闭后 sendTurn 一律抛错 */
  close(): Promise<void>
}

export interface StreamTransportOptions {
  config: AgentConfig
  platform: PlatformOps
  cwd: string
  sessionId: string
  /** 过滤后的人读文本,轮内实时回调(stderr 原样透传) */
  onChunk: (text: string) => void
  /** 空闲期(非轮次进行中)进程意外退出 */
  onUnexpectedExit: (code: number | null) => void
}

const CLOSE_GRACE_MS = 5_000

interface PendingRound {
  resolve: (result: RoundResult) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  startedAt: number
}

export class StreamTransport implements SessionTransport {
  private child: ChildProcess | null = null
  private pending: PendingRound | null = null
  private closed = false
  private readonly lines = new LineBuffer()

  constructor(private readonly opts: StreamTransportOptions) {}

  open(): Promise<void> {
    if (this.child) throw new Error('传输已打开')
    const { config, sessionId } = this.opts
    const argv = [
      ...renderSessionArgs(config.resume_stream_args, sessionId),
      ...config.auto_approve_args
    ]
    const child = spawn(config.bin, argv, {
      cwd: this.opts.cwd,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child = child
    child.stdout?.on('data', (c: Buffer) => this.consume(c.toString()))
    child.stderr?.on('data', (c: Buffer) => this.opts.onChunk(c.toString()))
    child.stdin?.once('error', () => {
      // 进程先亡导致 EPIPE:退出语义统一由 close 事件处理,此处仅防未捕获异常
    })
    child.once('close', (code) => this.handleExit(code))
    return new Promise((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', (e) => {
        this.child = null
        reject(new Error(`会话进程启动失败: ${config.bin}: ${e.message}`))
      })
    })
  }

  sendTurn(text: string, timeoutMs: number): Promise<RoundResult> {
    if (this.closed || !this.child?.stdin || this.child.exitCode !== null) {
      throw new Error('会话传输已关闭')
    }
    if (this.pending) throw new Error('上一轮未结束,不可发送')
    const message =
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] }
      }) + '\n'
    return new Promise<RoundResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null
        void this.close().finally(() => reject(new RoundTimeoutError()))
      }, timeoutMs)
      this.pending = { resolve, reject, timer, startedAt: Date.now() }
      this.child?.stdin?.write(message)
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const child = this.child
    if (!child || child.exitCode !== null) return
    const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
    child.stdin?.end()
    const grace = setTimeout(() => {
      if (child.pid) void this.opts.platform.killTree(child.pid)
    }, CLOSE_GRACE_MS)
    grace.unref()
    await exited
    clearTimeout(grace)
  }

  private consume(chunk: string): void {
    for (const line of this.lines.push(chunk)) {
      const event = parseStreamEvent(line)
      const display = event ? renderStreamEvent(event) : line + '\n'
      if (display) this.opts.onChunk(display)
      if (event && isResultStreamEvent(event)) this.settleRound(event)
    }
  }

  private settleRound(event: StreamEvent): void {
    const pending = this.pending
    if (!pending) return // 传输已超时自关等场景下的迟到 result,无轮可结
    this.pending = null
    clearTimeout(pending.timer)
    pending.resolve({
      durationMs: Date.now() - pending.startedAt,
      costUsd: event.total_cost_usd ?? null,
      isError: event.is_error === true
    })
  }

  private handleExit(code: number | null): void {
    const rest = this.lines.flush()
    if (rest) this.opts.onChunk(rest + '\n')
    const pending = this.pending
    if (pending) {
      this.pending = null
      clearTimeout(pending.timer)
      pending.reject(new SessionExitError(code))
      return
    }
    if (!this.closed) this.opts.onUnexpectedExit(code)
  }
}

export interface RoundSpawnTransportOptions {
  adapter: AgentAdapter
  cwd: string
  /** 归档目录,透传 AgentRunOptions.outDir */
  outDir: string
  sessionId: string
  onChunk: (text: string) => void
}

/** 每轮 spawn 的降级传输:resume 运行完全复用 GenericCliAdapter(argv 组装含 resume 模板) */
export class RoundSpawnTransport implements SessionTransport {
  private controller: AbortController | null = null
  private closed = false

  constructor(private readonly opts: RoundSpawnTransportOptions) {}

  open(): Promise<void> {
    return Promise.resolve()
  }

  async sendTurn(text: string, timeoutMs: number): Promise<RoundResult> {
    if (this.closed) throw new Error('会话传输已关闭')
    if (this.controller) throw new Error('上一轮未结束,不可发送')
    const controller = new AbortController()
    this.controller = controller
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const startedAt = Date.now()
    try {
      const { exitCode } = await this.opts.adapter.run({
        prompt: text,
        cwd: this.opts.cwd,
        outDir: this.opts.outDir,
        timeoutMs,
        onLog: this.opts.onChunk,
        signal: controller.signal,
        sessionId: this.opts.sessionId,
        resume: true
      })
      if (timedOut) {
        this.closed = true
        throw new RoundTimeoutError()
      }
      return { durationMs: Date.now() - startedAt, costUsd: null, isError: exitCode !== 0 }
    } finally {
      clearTimeout(timer)
      this.controller = null
    }
  }

  close(): Promise<void> {
    this.closed = true
    this.controller?.abort()
    return Promise.resolve()
  }
}
