import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openDatabase, SCHEMA_VERSION, TaskStore, ProjectStore } from '@core/db'
import { ConfigSchema } from '@core/config'
import { loadUiState, saveUiState } from '@core/ui-state'
import { renderPrompt, PROMPT_VARS } from '@core/prompt'
import type { Task } from '@shared/types'

/** W1a 契约层:migration v2、subAgent/phase 字段纪律、配置默认、模板三件套(Plan workflow-stage1) */

const WF_TEMPLATES = ['wf-plan.md', 'wf-implement.md', 'wf-review.md']

let dir: string
let db: Database
let projectId: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dispatch-wf-'))
  db = openDatabase(join(dir, 'test.db'))
  projectId = new ProjectStore(db).create({ name: 'demo', path: '/tmp/demo' }).id
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('migration v2', () => {
  it('schema 已含 v2,三列就位且旧行为 NULL/0 语义', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(2)
    const cols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(
      (c) => c.name
    )
    expect(cols).toEqual(expect.arrayContaining(['sub_agent', 'phase', 'review_round']))
  })
})

describe('TaskStore 工作流字段', () => {
  it('创建工作流任务:subAgent 落库,phase=null,reviewRound=0', () => {
    const store = new TaskStore(db)
    const task = store.create({
      text: 'x',
      projectId,
      agent: 'claude-code',
      subAgent: 'qwen',
      triggerType: 'immediate'
    })
    expect(task.subAgent).toBe('qwen')
    expect(task.phase).toBeNull()
    expect(task.reviewRound).toBe(0)
    expect(store.get(task.id)?.subAgent).toBe('qwen')
  })

  it('只选子不选主拒绝入库(create 与 updateEditable 同规则)', () => {
    const store = new TaskStore(db)
    expect(() =>
      store.create({ text: 'x', projectId, subAgent: 'qwen', triggerType: 'none' })
    ).toThrow(/主智能体/)
    const todo = store.create({ text: 'x', projectId, triggerType: 'none' })
    expect(() => store.updateEditable(todo.id, { subAgent: 'qwen' })).toThrow(/主智能体/)
  })

  it('setPhase 仅 running 允许,reviewRound 单调递增,触发 onChange', () => {
    const changes: Task[] = []
    const store = new TaskStore(db, (t) => changes.push(t))
    const task = store.create({
      text: 'x',
      projectId,
      agent: 'claude-code',
      subAgent: 'qwen',
      triggerType: 'immediate'
    })
    expect(() => store.setPhase(task.id, 'plan')).toThrow(/不允许设置 phase/)
    store.transition(task.id, 'running')
    const inPlan = store.setPhase(task.id, 'plan')
    expect(inPlan.phase).toBe('plan')
    store.setPhase(task.id, 'implement', 1)
    expect(() => store.setPhase(task.id, 'review', 0)).toThrow(/单调递增/)
    const cleared = store.setPhase(task.id, null)
    expect(cleared.phase).toBeNull()
    expect(cleared.reviewRound).toBe(1)
    expect(changes.filter((c) => c.status === 'running').length).toBeGreaterThanOrEqual(4)
  })

  it('失败重跑复制 subAgent(经 task-edit 校验于既有套件,此处验证 create 入参链路)', () => {
    const store = new TaskStore(db)
    const task = store.create({
      text: 'x',
      projectId,
      agent: 'claude-code',
      subAgent: 'kimi',
      triggerType: 'immediate'
    })
    expect(store.get(task.id)?.subAgent).toBe('kimi')
  })
})

describe('config 与 ui-state', () => {
  it('workflow_phase_timeout_min 默认 30/30/15', () => {
    const config = ConfigSchema.parse({})
    expect(config.workflow_phase_timeout_min).toEqual({ plan: 30, implement: 30, review: 15 })
  })

  it('ui-state 记忆 lastSubAgent', () => {
    const file = join(dir, 'ui-state.json')
    saveUiState(file, { lastSubAgent: 'qwen' })
    expect(loadUiState(file).lastSubAgent).toBe('qwen')
  })
})

describe('模板三件套契约', () => {
  it.each(WF_TEMPLATES)('%s:机读参数锚点、变量齐备、TASK_TEXT 仅一次', (name) => {
    const template = readFileSync(resolve(__dirname, '../resources/prompts', name), 'utf-8')
    expect(/^OUT_DIR:\s*\{OUT_DIR\}\s*$/m.test(template)).toBe(true)
    expect(template).toContain('{PROJECT_PATH}')
    expect(template.split('{TASK_TEXT}').length - 1).toBe(1)
  })

  it('wf-implement 含 REVIEW_FEEDBACK 注入位,wf-review 含 REVIEW_ROUND 文件名', () => {
    const impl = readFileSync(resolve(__dirname, '../resources/prompts/wf-implement.md'), 'utf-8')
    const review = readFileSync(resolve(__dirname, '../resources/prompts/wf-review.md'), 'utf-8')
    expect(impl).toContain('{REVIEW_FEEDBACK}')
    expect(review).toContain('review-r{REVIEW_ROUND}.json')
  })

  it('renderPrompt:可选变量缺省替换为「无」,提供时正常替换', () => {
    expect(PROMPT_VARS).toContain('REVIEW_FEEDBACK')
    const base = { TASK_TEXT: 't', OUT_DIR: '/o', PROJECT_PATH: '/p', BASE_BRANCH: 'main' }
    expect(renderPrompt('fb={REVIEW_FEEDBACK} r={REVIEW_ROUND}', base)).toBe('fb=无 r=无')
    expect(
      renderPrompt('fb={REVIEW_FEEDBACK} r={REVIEW_ROUND}', {
        ...base,
        REVIEW_FEEDBACK: '改这里',
        REVIEW_ROUND: '2'
      })
    ).toBe('fb=改这里 r=2')
  })
})
