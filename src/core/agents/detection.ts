import { spawn } from 'node:child_process'
import { AGENT_IDS, type AgentDetection, type AgentId } from '@shared/types'
import type { AgentConfig } from '../config'
import type { PlatformOps } from '../platform'
import type { DetectionStore } from '../db/detection-store'
import type { DetectResult } from './types'

const VERSION_TIMEOUT_MS = 3000

/** 两级检测(spec §5.3):findBinary 存在性 → version_args 可运行性 */
export async function detectAgent(
  config: AgentConfig,
  ops: PlatformOps,
  timeoutMs: number = VERSION_TIMEOUT_MS
): Promise<DetectResult> {
  const binPath = await ops.findBinary(config.bin)
  if (!binPath) {
    return { ok: false, failReason: `未找到二进制 ${config.bin}(PATH 中不存在)` }
  }
  return probeVersion(binPath, config, timeoutMs)
}

function probeVersion(
  binPath: string,
  config: AgentConfig,
  timeoutMs: number
): Promise<DetectResult> {
  const cmd = `${config.bin} ${config.version_args.join(' ')}`.trim()
  return new Promise((resolve) => {
    const child = spawn(binPath, config.version_args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let settled = false
    const done = (result: DetectResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      done({ ok: false, failReason: `${cmd} 超时(${timeoutMs}ms)` })
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.on('error', (err) => done({ ok: false, failReason: `无法执行 ${cmd}: ${err.message}` }))
    child.on('close', (code) => {
      if (code === 0) {
        done({ ok: true, version: output.trim().split('\n')[0] ?? '' })
      } else {
        done({ ok: false, failReason: `${cmd} 退出码 ${code}` })
      }
    })
  })
}

/** 对 config.agents 内全部已知 agent 逐个检测并 upsert 落库,返回落库后的全量结果 */
export async function runDetections(
  agents: Record<string, AgentConfig>,
  ops: PlatformOps,
  store: DetectionStore,
  timeoutMs?: number
): Promise<AgentDetection[]> {
  const ids = AGENT_IDS.filter((id): id is AgentId => agents[id] !== undefined)
  await Promise.all(
    ids.map(async (id) => {
      const result = await detectAgent(agents[id], ops, timeoutMs)
      store.upsert({
        agentId: id,
        ok: result.ok,
        version: result.version ?? null,
        failReason: result.failReason ?? null,
        checkedAt: new Date().toISOString()
      })
    })
  )
  return store.list()
}
