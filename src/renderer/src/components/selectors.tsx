import { AGENT_IDS, type AgentDetection, type AgentId, type Project } from '@shared/types'
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
      {AGENT_IDS.map((id) => {
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
      })}
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
