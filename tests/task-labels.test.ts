import { describe, expect, it } from 'vitest'
import { humanFailReason } from '../src/renderer/src/lib/task-labels'

/** failReason 技术码 → 中文展示映射(词表与 core 写入点同步) */

describe('humanFailReason', () => {
  it('固定码映射为中文', () => {
    expect(humanFailReason('session_abandoned')).toBe('会话已放弃')
    expect(humanFailReason('no_plan')).toBe('未产出方案文件(plan.md)')
    expect(humanFailReason('timeout')).toBe('执行超时')
    expect(humanFailReason('timeout_round')).toBe('本轮超时,会话终止')
    expect(humanFailReason('user_interrupted')).toBe('已手动中断')
    expect(humanFailReason('review_rejected')).toBe('审查未通过,超过返工上限')
    expect(humanFailReason('plugin_dispose')).toBe('服务退出,任务被中断')
    expect(humanFailReason('worktree_missing')).toBe('工作区已丢失')
  })

  it('exit_<n> 家族带退出码', () => {
    expect(humanFailReason('exit_1')).toBe('进程退出(码 1)')
    expect(humanFailReason('exit_137')).toBe('进程退出(码 137)')
  })

  it('session_exit_<n|null> 家族,null 显示未知', () => {
    expect(humanFailReason('session_exit_2')).toBe('会话进程退出(码 2)')
    expect(humanFailReason('session_exit_null')).toBe('会话进程退出(码 未知)')
  })

  it('agent_not_ready / round_error / internal / merge_retry 家族保留详情原文', () => {
    expect(humanFailReason('agent_not_ready: 版本检测失败')).toBe('智能体未就绪:版本检测失败')
    expect(humanFailReason('round_error: boom')).toBe('轮次失败:boom')
    expect(humanFailReason('internal: db locked')).toBe('内部错误:db locked')
    expect(humanFailReason('merge_retry: conflict')).toBe('合入失败,待重试:conflict')
  })

  it('未知码原样返回,不抛错', () => {
    expect(humanFailReason('some_new_code')).toBe('some_new_code')
    expect(humanFailReason('')).toBe('')
  })
})
