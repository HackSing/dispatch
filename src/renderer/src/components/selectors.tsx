import {
  AGENT_IDS,
  PLAN_MODES,
  WORKTREE_MODES,
  type AgentDetection,
  type AgentId,
  type PlanMode,
  type Project,
  type WorktreeMode
} from '@shared/types'
import type { TriggerType } from '@shared/types'

/** 捕获窗与主窗编辑表单共用的三选择器,行为保持一致(spec §3.1) */

export interface TriggerValue {
  triggerType: TriggerType
  /** datetime-local 控件格式,提交前经 fromDatetimeLocal 转 ISO */
  triggerAtLocal: string
}

export function TriggerSelect(props: {
  value: TriggerValue
  onChange: (next: TriggerValue) => void
}): React.JSX.Element {
  const { value, onChange } = props
  return (
    <>
      <select
        value={value.triggerType}
        title="执行时间"
        onChange={(e) =>
          onChange({ ...value, triggerType: e.target.value as TriggerType })
        }
      >
        <option value="none">不执行(todo)</option>
        <option value="immediate">立即执行</option>
        <option value="at">定时执行</option>
      </select>
      {value.triggerType === 'at' && (
        <input
          type="datetime-local"
          value={value.triggerAtLocal}
          onChange={(e) => onChange({ ...value, triggerAtLocal: e.target.value })}
        />
      )}
    </>
  )
}

/** 主/子选择器共用的候选项渲染:仅检测通过可选,未通过置灰含原因 */
function agentOptions(detections: AgentDetection[]): React.JSX.Element[] {
  return AGENT_IDS.map((id) => {
    const d = detections.find((x) => x.agentId === id)
    if (!d) {
      return (
        <option key={id} value={id} disabled>
          {id}(未检测)
        </option>
      )
    }
    return (
      <option key={id} value={id} disabled={!d.ok}>
        {d.ok ? `${id}${d.version ? ` · ${d.version}` : ''}` : `${id}(${d.failReason ?? '不可用'})`}
      </option>
    )
  })
}

export function AgentSelect(props: {
  detections: AgentDetection[]
  value: AgentId | ''
  onChange: (next: AgentId | '') => void
}): React.JSX.Element {
  const { detections, value, onChange } = props
  return (
    <select
      value={value}
      title="智能体"
      onChange={(e) => onChange(e.target.value as AgentId | '')}
    >
      <option value="">智能体(不指定)</option>
      {agentOptions(detections)}
    </select>
  )
}

/**
 * 子智能体选择器(工作流模式,可选):行为同主选择器;仅在已选主智能体时可用。
 * 允许主=子(自审模式),选「不使用」即回到单点流程。
 */
export function SubAgentSelect(props: {
  detections: AgentDetection[]
  value: AgentId | ''
  onChange: (next: AgentId | '') => void
  disabled: boolean
}): React.JSX.Element {
  const { detections, value, onChange, disabled } = props
  return (
    <select
      value={value}
      disabled={disabled}
      title={disabled ? '先选择主智能体' : '子智能体(可选):选择后进入 方案→实现→审查 工作流'}
      onChange={(e) => onChange(e.target.value as AgentId | '')}
    >
      <option value="">子智能体(不使用)</option>
      {agentOptions(detections)}
    </select>
  )
}

const PLAN_MODE_LABELS: Record<PlanMode, string> = {
  full: '完整方案',
  brief: '简单方案'
}

/** 方案档位选择器(仅单点模式生效):简单方案由智能体按难度定档,简单任务不停等确认直接执行 */
export function PlanModeSelect(props: {
  value: PlanMode
  onChange: (next: PlanMode) => void
  /** 工作流模式(subAgent 非空)下禁用:三段工作流始终走完整方案 */
  disabled?: boolean
}): React.JSX.Element {
  const { value, onChange, disabled } = props
  return (
    <select
      value={value}
      disabled={disabled}
      title={
        disabled
          ? '工作流模式始终走完整方案'
          : '方案档位:简单方案=智能体先判难度,简单任务产出薄方案后直接执行,复杂任务自动升级完整方案并暂停确认'
      }
      onChange={(e) => onChange(e.target.value as PlanMode)}
    >
      {PLAN_MODES.map((m) => (
        <option key={m} value={m}>
          {PLAN_MODE_LABELS[m]}
        </option>
      ))}
    </select>
  )
}

const WORKTREE_MODE_LABELS: Record<WorktreeMode, string> = {
  isolated: '新开 worktree',
  current: '当前工作区'
}

/** 工作区模式选择器:当前工作区=在项目主工作区直接执行,不建 worktree、不经合并(适合拉取代码等简单任务) */
export function WorktreeModeSelect(props: {
  value: WorktreeMode
  onChange: (next: WorktreeMode) => void
}): React.JSX.Element {
  const { value, onChange } = props
  return (
    <select
      value={value}
      title="工作区:新开 worktree=独立分支执行并自动合并回基线;当前工作区=在项目主工作区直接执行,不建 worktree、不经合并"
      onChange={(e) => onChange(e.target.value as WorktreeMode)}
    >
      {WORKTREE_MODES.map((m) => (
        <option key={m} value={m}>
          {WORKTREE_MODE_LABELS[m]}
        </option>
      ))}
    </select>
  )
}

const CREATE_PROJECT_VALUE = '__create__'

export function ProjectSelect(props: {
  projects: Project[]
  value: string
  onChange: (projectId: string) => void
  /** 触发系统选文件夹对话框并新建项目,返回新项目 id;取消返回 null */
  onCreateNew: () => Promise<string | null>
}): React.JSX.Element {
  const { projects, value, onChange, onCreateNew } = props
  return (
    <select
      value={value}
      title="项目"
      onChange={(e) => {
        const v = e.target.value
        if (v === CREATE_PROJECT_VALUE) {
          void onCreateNew().then((id) => {
            if (id) onChange(id)
          })
          return
        }
        onChange(v)
      }}
    >
      {projects.length === 0 && <option value="">(无项目)</option>}
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
      <option value={CREATE_PROJECT_VALUE}>新建项目…</option>
    </select>
  )
}
