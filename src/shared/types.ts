/** 主渲共用的领域类型唯一来源。改动此文件 = 改动跨线契约,需同步 dev-plan §1.4。 */

export const AGENT_IDS = ['claude-code', 'codex', 'dsh', 'kimi', 'qwen'] as const
export type AgentId = (typeof AGENT_IDS)[number]

/** 默认项目固定 id:启动种子(core/bootstrap)维护,捕获窗兜底与移除守卫共用 */
export const DEFAULT_PROJECT_ID = 'default'

export type TriggerType = 'immediate' | 'at' | 'none'

/** 工作流三段接力的展示性阶段字段:仅 running 期间有值,不进状态机(Plan workflow-stage1 决策) */
export const TASK_PHASES = ['plan', 'implement', 'review'] as const
export type TaskPhase = (typeof TASK_PHASES)[number]

/**
 * 方案档位:单点两跑的方案深度。
 * - full(默认):完整方案,产出后暂停 awaiting_confirm 等用户确认(既有行为)。
 * - brief:简单方案——方案跑先按难度定档:简单档产出薄方案(plan-mode.txt=brief)后
 *   执行器自动放行执行,不停等确认;复杂档自动升级为完整方案(plan-mode.txt=full)照常暂停。
 *   仅单点模式生效;工作流模式( subAgent 非空)始终走完整方案,忽略本字段。
 */
export const PLAN_MODES = ['full', 'brief'] as const
export type PlanMode = (typeof PLAN_MODES)[number]

/**
 * 工作区模式:执行位置。
 * - isolated(默认):从基线分支新开独立 worktree + 任务分支,完成后自动合并回基线(既有行为)。
 * - current:在项目主工作区当前检出直接执行,不建 worktree、不合并——适用于拉取代码等
 *   简单任务;执行提示词会追加工作区补充段(严禁 commit/push 等写操作,任务原文要求的除外)。
 */
export const WORKTREE_MODES = ['isolated', 'current'] as const
export type WorktreeMode = (typeof WORKTREE_MODES)[number]

/** 业务默认值单一来源:建任务/存储归一化的唯一缺省 */
export const DEFAULT_PLAN_MODE: PlanMode = 'full'
export const DEFAULT_WORKTREE_MODE: WorktreeMode = 'isolated'

export interface Task {
  id: string
  createdAt: string
  text: string
  projectId: string
  agent: AgentId | null
  /** 工作流模式的子智能体;null = 单点模式(既有流程零变化) */
  subAgent: AgentId | null
  /** 方案档位(单点两跑方案深度),见 PLAN_MODES */
  planMode: PlanMode
  /** 工作区模式(新开 worktree / 当前工作区),见 WORKTREE_MODES */
  worktreeMode: WorktreeMode
  triggerType: TriggerType
  triggerAt: string | null
  status: TaskStatus
  /**
   * 见 TASK_PHASES。工作流三段各阶段有值;方案确认闸上线后单点两跑也用之:方案跑 'plan'
   * (awaiting_confirm 期间冻结为 plan),确认重入执行跑 'implement',离开 running 前清 null。
   */
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
