import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadUiState, saveUiState } from '@core/ui-state'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dispatch-ui-state-'))
  file = join(dir, 'ui-state.json')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('ui-state', () => {
  it('文件缺失时生成默认并落盘', () => {
    const state = loadUiState(file)
    expect(state).toEqual({ lastAgent: null, lastSubAgent: null, lastProjectId: null, collapsedProjectIds: [] })
    expect(existsSync(file)).toBe(true)
  })

  it('保存后可回读,部分更新不覆盖其余字段', () => {
    saveUiState(file, { lastAgent: 'claude-code', lastSubAgent: null, lastProjectId: 'p1', collapsedProjectIds: [] })
    expect(loadUiState(file)).toEqual({ lastAgent: 'claude-code', lastSubAgent: null, lastProjectId: 'p1', collapsedProjectIds: [] })

    saveUiState(file, { lastProjectId: 'p2', collapsedProjectIds: [] })
    expect(loadUiState(file)).toEqual({ lastAgent: 'claude-code', lastSubAgent: null, lastProjectId: 'p2', collapsedProjectIds: [] })
  })

  it('损坏 JSON 静默重建(机器管理文件,不照 config 抛错)', () => {
    writeFileSync(file, '{ broken')
    expect(loadUiState(file)).toEqual({ lastAgent: null, lastSubAgent: null, lastProjectId: null, collapsedProjectIds: [] })
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({
      lastAgent: null,
      lastSubAgent: null,
      lastProjectId: null,
      collapsedProjectIds: []
    })
  })

  it('collapsedProjectIds 部分更新持久化,不动其余字段', () => {
    saveUiState(file, { lastProjectId: 'p1' })
    saveUiState(file, { collapsedProjectIds: ['p1', 'p2'] })
    expect(loadUiState(file)).toEqual({
      lastAgent: null,
      lastSubAgent: null,
      lastProjectId: 'p1',
      collapsedProjectIds: ['p1', 'p2']
    })
  })

  it('非法取值(未知 agent)重建为默认', () => {
    writeFileSync(file, JSON.stringify({ lastAgent: 'skynet', lastProjectId: 'p1', collapsedProjectIds: [] }))
    expect(loadUiState(file)).toEqual({ lastAgent: null, lastSubAgent: null, lastProjectId: null, collapsedProjectIds: [] })
  })
})
