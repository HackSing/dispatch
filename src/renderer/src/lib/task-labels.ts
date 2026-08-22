import type { Task, TaskPhase } from '@shared/types'
import type { TaskStatus } from '@shared/state-machine'

/** 列表与详情共用的任务展示文案(状态徽标/阶段/主→子链),渲染层唯一来源 */

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: '待办',
  scheduled: '已排程',
  running: '执行中',
  merging: '合并中',
  awaiting_merge: '待合并',
  conflict: '冲突',
  failed: '失败',
  done: '完成'
}

const PHASE_LABELS: Record<TaskPhase, string> = {
  plan: '方案',
  implement: '实现',
  review: '审查'
}

/**
 * 轮次后缀,与 executor/workflow.ts 的 setPhase 语义逐一对齐:
 * - implement 阶段 reviewRound = 已完成审查数(首轮 0)→ 实现轮次 = reviewRound + 1;
 * - review 阶段 reviewRound = 当前审查轮次(从 1 起)→ 直接显示;
 * 首轮(计数 ≤1 的审查、0 的实现)不带后缀,减少单点视觉噪音。
 */
function roundSuffix(task: Task): string {
  if (task.phase === 'implement' && task.reviewRound > 0) return ` r${task.reviewRound + 1}`
  if (task.phase === 'review' && task.reviewRound > 1) return ` r${task.reviewRound}`
  return ''
}

/** 状态徽标文案:running 且 phase 非空时细化为「执行中·方案/实现/审查 [rN]」 */
export function statusBadgeLabel(task: Task): string {
  if (task.status === 'running' && task.phase) {
    return `${STATUS_LABELS.running}·${PHASE_LABELS[task.phase]}${roundSuffix(task)}`
  }
  return STATUS_LABELS[task.status]
}

/** 智能体标识:工作流任务为「主 → 子」(如 claude-code → qwen),单点任务为主智能体名 */
export function agentChainLabel(task: Task): string | null {
  if (!task.agent) return null
  return task.subAgent ? `${task.agent} → ${task.subAgent}` : task.agent
}

/** 详情页元数据的当前阶段文案(含返工轮次);无阶段(单点/非执行中)为 null */
export function phaseDetailLabel(task: Task): string | null {
  if (!task.phase) return null
  return `${PHASE_LABELS[task.phase]}${roundSuffix(task)}`
}
