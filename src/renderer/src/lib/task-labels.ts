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

/**
 * failReason 技术码 → 人话中文。
 * 词表与 core 写入点同步(src/core/executor/index.ts、workflow.ts、follow-up.ts、
 * src/core/scheduler/recovery.ts、src/core/task-edit.ts、dispose 原因来自
 * src/shell/index.ts 与 dsh-plugin host):新增 failReason 时必须在此补映射。
 * 未认识的码原样返回,不抛错。
 */
const FAIL_REASON_LABELS: Record<string, string> = {
  timeout: '执行超时',
  timeout_plan: '方案阶段超时',
  timeout_implement: '实现阶段超时',
  timeout_review: '审查阶段超时',
  timeout_round: '本轮超时,会话终止',
  user_interrupted: '已手动中断',
  interrupted: '运行中被中断(应用退出)',
  abandoned: '已放弃',
  session_abandoned: '会话已放弃',
  missed_skipped: '错过定时,按策略跳过',
  prepare_failed: '准备命令失败(prepare_cmd)',
  no_plan: '未产出方案文件(plan.md)',
  no_result: '未产出结果文件(result.json)',
  bad_result: '结果文件格式不合法',
  result_failed: '智能体报告执行失败',
  worktree_missing: '工作区已丢失',
  review_rejected: '审查未通过,超过返工上限',
  base_dirty: '基线分支有未提交改动',
  base_checked_out_elsewhere: '基线被其他任务占用',
  app_quit: '应用退出,任务被中断',
  plugin_dispose: '服务退出,任务被中断'
}

export function humanFailReason(reason: string): string {
  const fixed = FAIL_REASON_LABELS[reason]
  if (fixed) return fixed
  let m = /^exit_(-?\d+)$/.exec(reason)
  if (m) return `进程退出(码 ${m[1]})`
  m = /^session_exit_(-?\d+|null)$/.exec(reason)
  if (m) return `会话进程退出(码 ${m[1] === 'null' ? '未知' : m[1]})`
  if (reason.startsWith('agent_not_ready: ')) return `智能体未就绪:${reason.slice('agent_not_ready: '.length)}`
  if (reason.startsWith('round_error: ')) return `轮次失败:${reason.slice('round_error: '.length)}`
  if (reason.startsWith('internal: ')) return `内部错误:${reason.slice('internal: '.length)}`
  if (reason.startsWith('merge_retry: ')) return `合入失败,待重试:${reason.slice('merge_retry: '.length)}`
  return reason
}
