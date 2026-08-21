/** Agent 适配层契约(spec §5.1)。B2 线实现 GenericCliAdapter 与 mock adapter,均以此为准。 */

import type { AgentId } from '@shared/types'

export interface DetectResult {
  ok: boolean
  version?: string
  failReason?: string
}

export interface AgentRunOptions {
  /** 完整拼装后的提示词 */
  prompt: string
  /** worktree 路径(非 git 项目为项目目录) */
  cwd: string
  /** 归档目录绝对路径,plan.md / result.json 写入处 */
  outDir: string
  timeoutMs: number
  onLog: (chunk: string) => void
  /** 取消/超时统一走 AbortSignal,由 executor 持有控制权 */
  signal?: AbortSignal
}

export interface AgentAdapter {
  id: AgentId
  /** 两级检测:which 存在性 → version 可运行性 */
  detect(): Promise<DetectResult>
  /** 运行前置钩子,默认空实现;dsh 在此拉起守护进程 */
  ensureReady(): Promise<void>
  run(opts: AgentRunOptions): Promise<{ exitCode: number }>
}

/** result.json 协议(spec §6.2),executor 完成判定依赖字段 */
export interface TaskResult {
  status: 'success' | 'partial' | 'failed'
  summary: string
  files_changed?: string[]
  follow_up?: string
  notes?: string
  started_at?: string
  finished_at?: string
}
