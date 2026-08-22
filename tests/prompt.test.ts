import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FALLBACK_TEMPLATE, loadPromptTemplate, renderPrompt } from '@core/prompt'

let dir: string
let promptsDir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dispatch-prompt-'))
  promptsDir = join(dir, 'prompts')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('loadPromptTemplate', () => {
  it('default.md 与内置模板都缺失时落盘占位模板', () => {
    const template = loadPromptTemplate(promptsDir)
    expect(template).toBe(FALLBACK_TEMPLATE)
    expect(readFileSync(join(promptsDir, 'default.md'), 'utf-8')).toBe(FALLBACK_TEMPLATE)
    // mock agent 依赖的解析锚点
    expect(template).toMatch(/^OUT_DIR: \{OUT_DIR\}$/m)
  })

  it('default.md 缺失时从内置模板拷贝', () => {
    const builtin = join(dir, 'builtin.md')
    writeFileSync(builtin, '内置模板 {TASK_TEXT}')
    expect(loadPromptTemplate(promptsDir, builtin)).toBe('内置模板 {TASK_TEXT}')
    expect(readFileSync(join(promptsDir, 'default.md'), 'utf-8')).toBe('内置模板 {TASK_TEXT}')
  })

  it('用户已有 default.md 时不被内置模板覆盖', () => {
    const builtin = join(dir, 'builtin.md')
    writeFileSync(builtin, '内置模板')
    loadPromptTemplate(promptsDir)
    writeFileSync(join(promptsDir, 'default.md'), '用户改过的模板')
    expect(loadPromptTemplate(promptsDir, builtin)).toBe('用户改过的模板')
  })
})

describe('renderPrompt', () => {
  const vars = {
    TASK_TEXT: '修 bug',
    OUT_DIR: '/tmp/out',
    PROJECT_PATH: '/tmp/proj',
    BASE_BRANCH: 'main'
  }

  it('替换四个已知变量,支持多次出现', () => {
    const out = renderPrompt(
      '{TASK_TEXT} @ {PROJECT_PATH} ({BASE_BRANCH})\n写入 {OUT_DIR}/plan.md 与 {OUT_DIR}/result.json',
      vars
    )
    expect(out).toBe('修 bug @ /tmp/proj (main)\n写入 /tmp/out/plan.md 与 /tmp/out/result.json')
  })

  it('未知 {VAR} 原样保留', () => {
    expect(renderPrompt('{TASK_TEXT} {UNKNOWN_VAR} {OUT_DIR}', vars)).toBe(
      '修 bug {UNKNOWN_VAR} /tmp/out'
    )
  })
})
