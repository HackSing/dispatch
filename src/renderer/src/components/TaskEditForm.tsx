import { useState } from 'react'
import type { AgentDetection, AgentId, Project, Task } from '@shared/types'
import { AgentSelect, ProjectSelect, TriggerSelect, type TriggerValue } from './selectors'
import { fromDatetimeLocal, toDatetimeLocal } from '../lib/time'

/** todo/scheduled 的内联编辑;补时间+agent 保存即由主进程升级为可执行任务 */
export function TaskEditForm(props: {
  task: Task
  projects: Project[]
  detections: AgentDetection[]
  onCreateProject: () => Promise<string | null>
  onClose: () => void
}): React.JSX.Element {
  const { task, projects, detections, onCreateProject, onClose } = props
  const [text, setText] = useState(task.text)
  const [projectId, setProjectId] = useState(task.projectId)
  const [agent, setAgent] = useState<AgentId | ''>(task.agent ?? '')
  const [trigger, setTrigger] = useState<TriggerValue>({
    triggerType: task.triggerType,
    triggerAtLocal: toDatetimeLocal(task.triggerAt)
  })
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const save = async (): Promise<void> => {
    if (!text.trim()) {
      setError('任务文本不能为空')
      return
    }
    if (trigger.triggerType !== 'none' && !agent) {
      setError('可执行任务需选择智能体')
      return
    }
    const triggerAt = trigger.triggerType === 'at' ? fromDatetimeLocal(trigger.triggerAtLocal) : null
    if (trigger.triggerType === 'at' && !triggerAt) {
      setError('请选择执行时间')
      return
    }
    setSaving(true)
    try {
      await window.dispatchApi.invoke('task:update', {
        id: task.id,
        text,
        projectId,
        agent: agent || null,
        triggerType: trigger.triggerType,
        triggerAt
      })
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="task-edit">
      <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="field-row">
        <TriggerSelect value={trigger} onChange={setTrigger} />
        <AgentSelect detections={detections} value={agent} onChange={setAgent} />
        <ProjectSelect
          projects={projects}
          value={projectId}
          onChange={setProjectId}
          onCreateNew={onCreateProject}
        />
      </div>
      <div className="field-row">
        <button className="btn primary" disabled={saving} onClick={() => void save()}>
          保存
        </button>
        <button className="btn" onClick={onClose}>
          取消
        </button>
        {error && <span className="form-error">{error}</span>}
      </div>
    </div>
  )
}
