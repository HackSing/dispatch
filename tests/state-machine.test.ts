import { describe, expect, it } from 'vitest'
import {
  TASK_STATUSES,
  TRANSITIONS,
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
      ['merging', 'done'],
      ['merging', 'awaiting_merge'],
      ['awaiting_merge', 'merging'],
      ['merging', 'conflict'],
      ['conflict', 'merging'],
      ['running', 'failed'],
      ['running', 'done'], // no_vcs 项目
      ['todo', 'done'], // 手动勾选
      ['scheduled', 'todo'] // 取消执行
    ] as const
    for (const [from, to] of happyPath) {
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(true)
    }
  })

  it('终态不可再迁移', () => {
    for (const to of TASK_STATUSES) {
      expect(canTransition('done', to)).toBe(false)
      expect(canTransition('failed', to)).toBe(false)
    }
  })

  it('非法迁移抛 IllegalTransitionError', () => {
    expect(() => assertTransition('todo', 'running')).toThrow(IllegalTransitionError)
    expect(() => assertTransition('done', 'todo')).toThrow(IllegalTransitionError)
    expect(() => assertTransition('scheduled', 'merging')).toThrow(IllegalTransitionError)
  })
})
