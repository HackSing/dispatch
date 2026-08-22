import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadPromptTemplate, renderPrompt } from '@core/prompt'

// default 模板只要求四个核心变量;REVIEW_* 是工作流模板专属可选变量
const CORE_VARS = ['TASK_TEXT', 'OUT_DIR', 'PROJECT_PATH', 'BASE_BRANCH'] as const

/** 真模板(resources/prompts/default.md)与执行链路的兼容契约,断了任何一条都会静默破坏实机执行或测试 */

const BUILTIN = resolve(__dirname, '../resources/prompts/default.md')
// tests/fixtures/mock-agent.cjs 的解析锚点,正则须与其保持一致
const MOCK_OUT_DIR_ANCHOR = /^OUT_DIR:\s*(.+)\s*$/m

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dispatch-prompt-real-'))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('真模板兼容性', () => {
  it('loadPromptTemplate 优先拷贝内置真模板而非占位兜底', () => {
    const template = loadPromptTemplate(dir, BUILTIN)
    expect(template).toBe(readFileSync(BUILTIN, 'utf-8'))
    expect(template).not.toContain('占位模板')
  })

  it('四个变量占位符齐备,且 TASK_TEXT 仅出现一次(替换安全约定)', () => {
    const template = readFileSync(BUILTIN, 'utf-8')
    for (const name of CORE_VARS) {
      expect(template, name).toContain(`{${name}}`)
    }
    expect(template.split('{TASK_TEXT}').length - 1).toBe(1)
  })

  it('渲染后无残留占位符,且 mock agent 的 OUT_DIR 锚点行可解析', () => {
    const template = readFileSync(BUILTIN, 'utf-8')
    const rendered = renderPrompt(template, {
      TASK_TEXT: '修复登录页的报错',
      OUT_DIR: '/tmp/archive/2026-08-22-abc123',
      PROJECT_PATH: '/tmp/project',
      BASE_BRANCH: 'main'
    })
    for (const name of CORE_VARS) {
      expect(rendered).not.toContain(`{${name}}`)
    }
    const match = MOCK_OUT_DIR_ANCHOR.exec(rendered)
    expect(match?.[1]).toBe('/tmp/archive/2026-08-22-abc123')
  })
})
