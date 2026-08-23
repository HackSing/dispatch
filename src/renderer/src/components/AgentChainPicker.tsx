import { useRef, useState } from 'react'
import { AGENT_IDS, type AgentDetection, type AgentId } from '@shared/types'
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpDownIcon,
  ChipIcon
} from './icons'
import { usePopoverDismiss } from '../lib/use-popover'

/**
 * 智能体链选择器(捕获窗,交互定稿):一枚胶囊显示「主 → 子」,点开为分步级联——
 * 第一步只弹主智能体列表;选定主后子智能体面板在原位从左侧滑入(默认不使用,
 * 点选即选中,主 = 子为自审),面板头部「‹ 主智能体」可返回第一步。检测未通过的
 * 项禁用置灰。语义与 selectors.tsx 的主/子选择器一致:清空主智能体即回单点模式
 * 并连带清空子。
 */

const UNSET_MAIN_LABEL = '智能体(不指定)'

function chainLabel(agent: AgentId | '', subAgent: AgentId | ''): string {
  if (!agent) return UNSET_MAIN_LABEL
  return subAgent ? `${agent} → ${subAgent}` : agent
}

interface RowState {
  id: AgentId
  ok: boolean
  verText: string
}

function toRowStates(detections: AgentDetection[]): RowState[] {
  return AGENT_IDS.map((id) => {
    const d = detections.find((x) => x.agentId === id)
    if (!d) return { id, ok: false, verText: '未检测' }
    return { id, ok: d.ok, verText: d.ok ? (d.version ?? '') : (d.failReason ?? '不可用') }
  })
}

function PanelRow(props: {
  selected: boolean
  disabled: boolean
  cascade?: boolean
  verText?: string
  mono?: boolean
  label: string
  onPick: () => void
}): React.JSX.Element {
  return (
    <button
      className={`picker-row${props.selected ? ' sel' : ''}`}
      disabled={props.disabled}
      onClick={props.onPick}
    >
      <span className="ckcol">{props.selected && <CheckIcon />}</span>
      <span className={props.mono ? 'mono' : undefined}>{props.label}</span>
      {props.verText !== undefined && (
        <span className="picker-ver" title={props.verText}>
          {props.verText}
        </span>
      )}
      {props.cascade && <ChevronRightIcon />}
    </button>
  )
}

export function AgentChainPicker(props: {
  detections: AgentDetection[]
  agent: AgentId | ''
  subAgent: AgentId | ''
  onChange: (agent: AgentId | '', subAgent: AgentId | '') => void
}): React.JSX.Element {
  const { detections, agent, subAgent, onChange } = props
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<'main' | 'sub'>('main')
  const wrapRef = useRef<HTMLDivElement | null>(null)

  usePopoverDismiss(open, wrapRef, () => setOpen(false))

  const rows = toRowStates(detections)

  const toggleOpen = (): void => {
    if (open) {
      setOpen(false)
      return
    }
    // 每次点开都从第一步(主智能体)开始,选定主后才滑入子面板
    setStep('main')
    setOpen(true)
  }

  const pickMain = (id: AgentId | ''): void => {
    if (!id) {
      // 清空主智能体即回单点模式,子连带清空;无子可选,直接收起
      onChange('', '')
      setOpen(false)
      return
    }
    onChange(id, subAgent)
    setStep('sub')
  }

  const pickSub = (id: AgentId | ''): void => {
    onChange(agent, id)
    setOpen(false)
  }

  return (
    <div className="picker-wrap" ref={wrapRef}>
      <button
        className={`capture-pop${open ? ' open' : ''}`}
        title="智能体(主 → 子);选择子智能体后进入 方案→实现→审查 工作流"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggleOpen}
      >
        <ChipIcon />
        <span className={agent ? 'mono' : undefined}>{chainLabel(agent, subAgent)}</span>
        <ChevronUpDownIcon />
      </button>
      {open && (
        <div className="picker-pop" role="dialog" aria-label="选择智能体">
          {step === 'main' ? (
            <div className="picker-panel">
              <div className="picker-head">主智能体</div>
              <PanelRow
                label="不指定"
                selected={agent === ''}
                disabled={false}
                onPick={() => pickMain('')}
              />
              {rows.map((r) => (
                <PanelRow
                  key={r.id}
                  label={r.id}
                  mono
                  verText={r.verText}
                  selected={agent === r.id}
                  cascade={r.ok}
                  disabled={!r.ok}
                  onPick={() => pickMain(r.id)}
                />
              ))}
            </div>
          ) : (
            <div className="picker-panel slide-in">
              <button
                className="picker-back"
                title="返回主智能体"
                onClick={() => setStep('main')}
              >
                <ChevronLeftIcon />
                <span className="mono">{agent}</span>
                <span className="picker-back-tail">子智能体</span>
              </button>
              <PanelRow
                label="不使用"
                selected={subAgent === ''}
                disabled={false}
                onPick={() => pickSub('')}
              />
              {rows.map((r) => (
                <PanelRow
                  key={r.id}
                  label={r.id}
                  mono
                  verText={r.id === agent ? '自审' : r.verText}
                  selected={subAgent === r.id}
                  disabled={!r.ok}
                  onPick={() => pickSub(r.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
