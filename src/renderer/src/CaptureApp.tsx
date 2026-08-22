import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentDetection, AgentId, Project } from '@shared/types'
import { DEFAULT_PROJECT_ID } from '@shared/types'
import { AgentChainPicker } from './components/AgentChainPicker'
import { ClockIcon, FolderIcon } from './components/icons'
import { ProjectSelect, TriggerSelect, type TriggerValue } from './components/selectors'
import { pickAndCreateProject } from './lib/projects'
import { fromDatetimeLocal } from './lib/time'

/** 捕获窗(spec §3.1):Enter 提交、Shift+Enter 换行、Esc 收起;记忆上次智能体与项目 */
export function CaptureApp(): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([])
  const [detections, setDetections] = useState<AgentDetection[]>([])
  const [text, setText] = useState('')
  const [trigger, setTrigger] = useState<TriggerValue>({ triggerType: 'none', triggerAtLocal: '' })
  const [agent, setAgent] = useState<AgentId | ''>('')
  const [subAgent, setSubAgent] = useState<AgentId | ''>('')
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
      if (projectList.some((p) => p.id === DEFAULT_PROJECT_ID)) return DEFAULT_PROJECT_ID
      return projectList[0]?.id ?? ''
    })
    if (!restoredFromUiState.current) {
      restoredFromUiState.current = true
      const usable = (id: AgentId | null): id is AgentId =>
        id !== null && detectionList.some((d) => d.agentId === id && d.ok)
      if (usable(uiState.lastAgent)) {
        setAgent(uiState.lastAgent)
        // 子智能体依赖主智能体,仅在主恢复成功时一并恢复
        if (usable(uiState.lastSubAgent)) setSubAgent(uiState.lastSubAgent)
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
        subAgent: (agent && subAgent) || null,
        triggerType: trigger.triggerType,
        triggerAt
      })
      await window.dispatchApi.invoke('ui-state:set', {
        lastAgent: agent || null,
        lastSubAgent: (agent && subAgent) || null,
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
        <div className="capture-pop" title="执行时间">
          <ClockIcon />
          <TriggerSelect value={trigger} onChange={setTrigger} />
        </div>
        <AgentChainPicker
          detections={detections}
          agent={agent}
          subAgent={subAgent}
          onChange={(nextAgent, nextSub) => {
            setAgent(nextAgent)
            // 子依赖主:清空主智能体即回单点模式
            setSubAgent(nextAgent ? nextSub : '')
          }}
        />
        <div className="capture-pop" title="项目">
          <FolderIcon />
          <ProjectSelect
            projects={projects}
            value={projectId}
            onChange={setProjectId}
            onCreateNew={createProject}
          />
        </div>
        {error && <span className="form-error">{error}</span>}
        <span className="spacer" />
        <button className="btn primary" disabled={saving} onClick={() => void submit()}>
          派单 <span className="key">↵</span>
        </button>
      </div>
    </div>
  )
}
