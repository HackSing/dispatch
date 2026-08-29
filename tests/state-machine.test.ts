import { describe, expect, it } from 'vitest'
import {
  TASK_STATUSES,
  TRANSITIONS,
  SETTLED_STATUSES,
  canTransition,
  assertTransition,
  IllegalTransitionError
} from '@shared/state-machine'

describe('state machine', () => {
  it('迁移表覆盖全部状态', () => {
    for (const s of TASK_STATUSES) {
      expect(TRANSITIONS[s]).toBeDefined()
    }
  })

  it('spec §4.2 主路径全部合法', () => {
    const happyPath = [
      ['todo', 'scheduled'],
      ['scheduled', 'running'],
      ['running', 'merging'],
      ['running', 'awaiting_confirm'], // 方案判过暂停,等用户确认
      ['awaiting_confirm', 'scheduled'], // 用户确认放行,重新入队
      ['awaiting_confirm', 'failed'], // 用户放弃(abandoned)
      ['merging', 'done'],
      ['merging', 'awaiting_merge'],
      ['awaiting_merge', 'merging'],
      ['merging', 'conflict'],
      ['conflict', 'merging'],
      ['running', 'failed'],
      ['running', 'done'], // no_vcs 项目
      ['todo', 'done'], // 手动勾选
      ['scheduled', 'todo'], // 取消执行
      ['done', 'todo'] // 手动重开(交互批 V0.2)
    ] as const
    for (const [from, to] of happyPath) {
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(true)
    }
  })

  it('done 仅可手动重开回 todo;failed 仅可原地重跑回 scheduled', () => {
    for (const to of TASK_STATUSES) {
      expect(canTransition('done', to)).toBe(to === 'todo')
      expect(canTransition('failed', to)).toBe(to === 'scheduled')
    }
  })

  it('非法迁移抛 IllegalTransitionError', () => {
    expect(() => assertTransition('todo', 'running')).toThrow(IllegalTransitionError)
    expect(() => assertTransition('done', 'scheduled')).toThrow(IllegalTransitionError)
    expect(() => assertTransition('scheduled', 'merging')).toThrow(IllegalTransitionError)
    // awaiting_confirm 只能确认(→scheduled)或放弃(→failed),不可直接回执行态
    expect(() => assertTransition('awaiting_confirm', 'running')).toThrow(IllegalTransitionError)
    // 方案暂停只从 running 迁入,不可从 todo 直达
    expect(() => assertTransition('todo', 'awaiting_confirm')).toThrow(IllegalTransitionError)
  })

  it('awaiting_confirm 是活跃态,不属于已结算清单', () => {
    expect(SETTLED_STATUSES).not.toContain('awaiting_confirm')
    expect(SETTLED_STATUSES).toEqual(['done', 'failed'])
  })
})
