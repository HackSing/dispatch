/** 主渲共用的领域类型唯一来源。改动此文件 = 改动跨线契约,需同步 dev-plan §1.4。 */

export const AGENT_IDS = ['claude-code', 'codex', 'dsh', 'kimi', 'qwen'] as const
export type AgentId = (typeof AGENT_IDS)[number]

export type TriggerType = 'immediate' | 'at' | 'none'

export interface Task {
  id: string
  createdAt: string
  text: string
  projectId: string
  agent: AgentId | null
  triggerType: TriggerType
  triggerAt: string | null
  status: TaskStatus
  baseBranch: string | null
  branch: string | null
  worktreePath: string | null
  archiveDir: string | null
  failReason: string | null
  scheduledAt: string | null
  startedAt: string | null
  finishedAt: string | null
  mergedAt: string | null
}

export interface Project {
  id: string
  name: string
  path: string
  prepareCmd: string | null
  /** null = 执行时取主工作区当前分支 */
  baseBranch: string | null
  createdAt: string
}

export interface AgentDetection {
  agentId: AgentId
  ok: boolean
  version: string | null
  failReason: string | null
  checkedAt: string
}

import type { TaskStatus } from './state-machine'
export type { TaskStatus }
