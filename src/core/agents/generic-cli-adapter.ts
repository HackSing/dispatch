import { execFile, spawn, type ChildProcess } from 'node:child_process'
import type { AgentId } from '@shared/types'
import type { AgentConfig } from '@core/config'
import type { PlatformOps } from '@core/platform'
import { runShell, spawnShellDetached } from '@core/proc/shell'
import { createLogFilter } from './log-filters'
import { buildBaseArgs } from './session'
import type { AgentAdapter, AgentRunOptions, DetectResult } from './types'

const READY_TIMEOUT_MS = 30_000
const READY_POLL_MS = 1000

export interface GenericCliAdapterOptions {
  readyTimeoutMs?: number
  readyPollMs?: number
}

/**
 * 唯一的 CLI 适配器实现:行为完全由 AgentConfig 驱动,代码内禁止出现 agent 特有分支
 * (spec §5.2 原则)。超时/取消统一经 AgentRunOptions.signal,本类不自设定时器。
 */
export class GenericCliAdapter implements AgentAdapter {
  private readonly readyTimeoutMs: number
  private readonly readyPollMs: number

  constructor(
    public readonly id: AgentId,
    private readonly config: AgentConfig,
    private readonly platform: PlatformOps,
    opts: GenericCliAdapterOptions = {}
  ) {
    this.readyTimeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS
    this.readyPollMs = opts.readyPollMs ?? READY_POLL_MS
  }

  async detect(): Promise<DetectResult> {
    const bin = await this.platform.findBinary(this.config.bin)
    if (!bin) return { ok: false, failReason: `未找到可执行文件 ${this.config.bin}` }
    const plan = this.platform.buildSpawn(bin, this.config.version_args)
    return new Promise((resolve) => {
      execFile(
        plan.file,
        plan.args,
        { windowsVerbatimArguments: plan.windowsVerbatimArguments },
        (err, stdout, stderr) => {
          if (err) {
            resolve({ ok: false, failReason: `版本检测失败: ${stderr.trim() || err.message}` })
          } else {
            resolve({ ok: true, version: stdout.trim().split(/\r?\n/)[0] })
          }
        }
      )
    })
  }

  /** ready_check 通过即就绪;失败则 start_cmd 拉起并轮询,超时抛错 */
  async ensureReady(): Promise<void> {
    if (!this.config.ready_check_cmd) return
    if ((await runShell(this.config.ready_check_cmd)).exitCode === 0) return
    if (!this.config.start_cmd) {
      throw new Error(`agent ${this.id} 未就绪(ready_check 失败)且未配置 start_cmd`)
    }
    spawnShellDetached(this.config.start_cmd)
    const deadline = Date.now() + this.readyTimeoutMs
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, this.readyPollMs))
      if ((await runShell(this.config.ready_check_cmd)).exitCode === 0) return
    }
    throw new Error(`agent ${this.id} 执行 start_cmd 后 ${this.readyTimeoutMs}ms 内未就绪`)
  }

  async run(opts: AgentRunOptions): Promise<{ exitCode: number }> {
    if (opts.signal?.aborted) return { exitCode: -1 }
    const bin = await this.platform.findBinary(this.config.bin)
    if (!bin) {
      throw new Error(`agent 进程启动失败: ${this.config.bin}: 未找到可执行文件`)
    }
    const base = buildBaseArgs(this.id, this.config, opts)
    const argv = [...base, ...this.config.auto_approve_args]
    if (this.config.prompt_via === 'arg') argv.push(opts.prompt)
    const plan = this.platform.buildSpawn(bin, argv)
    const child = spawn(plan.file, plan.args, {
      cwd: opts.cwd,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsVerbatimArguments: plan.windowsVerbatimArguments
    })
    // stdout 经配置指定的过滤器转人可读;stderr 原样保留
    const filter = createLogFilter(this.config.log_filter)
    const emit = (text: string): void => {
      if (text) opts.onLog(text)
    }
    child.stdout.on('data', (c: Buffer) => emit(filter.transform(c.toString())))
    child.stderr.on('data', (c: Buffer) => opts.onLog(c.toString()))
    child.stdout.once('close', () => emit(filter.flush()))
    this.feedStdin(child, opts)
    return this.waitExit(child, opts)
  }

  private feedStdin(child: ChildProcess, opts: AgentRunOptions): void {
    if (!child.stdin) return
    child.stdin.once('error', () => {
      // 进程未读完 stdin 即退出(EPIPE),按退出码判定,不在此抛出
    })
    if (this.config.prompt_via === 'stdin') child.stdin.write(opts.prompt)
    child.stdin.end()
  }

  private waitExit(child: ChildProcess, opts: AgentRunOptions): Promise<{ exitCode: number }> {
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        if (child.pid) void this.platform.killTree(child.pid)
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      if (opts.signal?.aborted) onAbort()
      child.once('error', (e) => {
        opts.signal?.removeEventListener('abort', onAbort)
        reject(new Error(`agent 进程启动失败: ${this.config.bin}: ${e.message}`))
      })
      child.once('close', (code) => {
        opts.signal?.removeEventListener('abort', onAbort)
        if (opts.signal?.aborted) resolve({ exitCode: -1 })
        else resolve({ exitCode: code ?? -1 })
      })
    })
  }
}
