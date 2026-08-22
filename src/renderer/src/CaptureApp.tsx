import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentDetection, AgentId, Project } from '@shared/types'
import { AgentSelect, ProjectSelect, TriggerSelect, type TriggerValue } from './components/selectors'
import { pickAndCreateProject } from './lib/projects'
import { fromDatetimeLocal } from './lib/time'

/** 捕获窗(spec §3.1):Enter 提交、Shift+Enter 换行、Esc 收起;记忆上次智能体与项目 */
export function CaptureApp(): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([])
  const [detections, setDetections] = useState<AgentDetection[]>([])
  const [text, setText] = useState('')
  const [trigger, setTrigger] = useState<TriggerValue>({ triggerType: 'none', triggerAtLocal: '' })
  const [agent, setAgent] = useState<AgentId | ''>('')
  const [projectId, setProjectId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const restoredFromUiState = useRef(false)

  const load = useCallback(async (): Promise<void> => {
    const [projectList, detectionList, uiState] = await Promise.all([
      window.dispatchApi.invoke('project:list', undefined),
      window.dispatchApi.invoke('agent:detections', undefined),
      window.dispatchApi.invoke('ui-state:get', undefined)
    ])
    setProjects(projectList)
    setDetections(detectionList)
    setProjectId((prev) => {
      if (prev && projectList.some((p) => p.id === prev)) return prev
      if (uiState.lastProjectId && projectList.some((p) => p.id === uiState.lastProjectId)) {
        return uiState.lastProjectId
      }
      if (projectList.some((p) => p.id === 'default')) return 'default'
      return projectList[0]?.id ?? ''
    })
    if (!restoredFromUiState.current) {
      restoredFromUiState.current = true
      if (
        uiState.lastAgent &&
        detectionList.some((d) => d.agentId === uiState.lastAgent && d.ok)
      ) {
        setAgent(uiState.lastAgent)
      }
    }
  }, [])

  const hide = useCallback((): void => {
    setError(null)
    setText('')
    void window.dispatchApi.invoke('capture:hide', undefined)
  }, [])

  useEffect(() => {
    void load()
    const offDetections = window.dispatchApi.on('agent:detections-changed', ({ detections: d }) =>
      setDetections(d)
    )
    const onFocus = (): void => {
      void load()
      textareaRef.current?.focus()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      offDetections()
      window.removeEventListener('focus', onFocus)
    }
  }, [load])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') hide()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hide])

  const submit = async (): Promise<void> => {
    if (saving) return
    if (!text.trim()) {
      setError('任务文本不能为空')
      return
    }
    if (!projectId) {
      setError('还没有项目,请先通过「新建项目…」创建')
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
      await window.dispatchApi.invoke('task:create', {
        text,
        projectId,
        agent: agent || null,
        triggerType: trigger.triggerType,
        triggerAt
      })
      await window.dispatchApi.invoke('ui-state:set', {
        lastAgent: agent || null,
        lastProjectId: projectId
      })
      setText('')
      setError(null)
      setTrigger({ triggerType: 'none', triggerAtLocal: '' })
      await window.dispatchApi.invoke('capture:hide', undefined)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const createProject = (): Promise<string | null> =>
    pickAndCreateProject(async () => {
      setProjects(await window.dispatchApi.invoke('project:list', undefined))
    })

  return (
    <div className="capture">
      <div className="capture-drag">
        <span>快速捕获</span>
        <span>Enter 提交 · Shift+Enter 换行 · Esc 收起</span>
      </div>
      <textarea
        ref={textareaRef}
        autoFocus
        placeholder="记下任务,回车派单…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void submit()
          }
        }}
      />
      <div className="capture-bar">
        <TriggerSelect value={trigger} onChange={setTrigger} />
        <AgentSelect detections={detections} value={agent} onChange={setAgent} />
        <ProjectSelect
          projects={projects}
          value={projectId}
          onChange={setProjectId}
          onCreateNew={createProject}
        />
        {error && <span className="form-error">{error}</span>}
      </div>
    </div>
  )
}
