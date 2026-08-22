/** 主渲共用的领域类型唯一来源。改动此文件 = 改动跨线契约,需同步 dev-plan §1.4。 */

export const AGENT_IDS = ['claude-code', 'codex', 'dsh', 'kimi', 'qwen'] as const
export type AgentId = (typeof AGENT_IDS)[number]

export type TriggerType = 'immediate' | 'at' | 'none'

/** 工作流三段接力的展示性阶段字段:仅 running 期间有值,不进状态机(Plan workflow-stage1 决策) */
export const TASK_PHASES = ['plan', 'implement', 'review'] as const
export type TaskPhase = (typeof TASK_PHASES)[number]

export interface Task {
  id: string
  createdAt: string
  text: string
  projectId: string
  agent: AgentId | null
  /** 工作流模式的子智能体;null = 单点模式(既有流程零变化) */
  subAgent: AgentId | null
  triggerType: TriggerType
  triggerAt: string | null
  status: TaskStatus
  /** 见 TASK_PHASES;单点模式恒为 null */
  phase: TaskPhase | null
  /**
   * 主智能体最近一次 fresh run 的会话 id(执行前预生成落库;工作流模式 plan/review
   * 各自生成、后写覆盖,任务最终留最后一次主 agent 会话)。null = 尚未执行或 agent 不支持会话。
   */
  sessionId: string | null
  /** 接力任务指向原任务;null = 非接力。接力任务以 --resume 续原会话执行 */
  parentTaskId: string | null
  /** 审查打回返工轮次,0 = 首轮实现 */
  reviewRound: number
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
