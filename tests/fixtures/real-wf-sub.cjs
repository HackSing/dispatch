#!/usr/bin/env node
/**
 * 实机返工路径专用 mock 子智能体:
 * 首轮(提示词审查意见为「无」)故意违背方案写 VERSION=1 并谎报 success;
 * 返工轮(有审查意见)改为正确的 VERSION=2。
 * 用于验证真实主智能体审查者能抓住违背方案的实现并给出可执行返工意见。
 */
const { readFileSync, writeFileSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

const prompt = readFileSync(0, 'utf-8')
const outDir = /^OUT_DIR:\s*(.+)\s*$/m.exec(prompt)?.[1]
if (!outDir) {
  console.error('real-wf-sub: 提示词中未找到 OUT_DIR 行')
  process.exit(3)
}
const feedbackMatch = /<review_feedback>\s*([\s\S]*?)\s*<\/review_feedback>/.exec(prompt)
const firstRound = !feedbackMatch || feedbackMatch[1].trim() === '无'

const content = firstRound ? 'VERSION=1\n' : 'VERSION=2\n'
writeFileSync(join(process.cwd(), 'NOTES.md'), content)
execFileSync('git', ['add', '-A'], { cwd: process.cwd() })
execFileSync('git', ['commit', '-m', firstRound ? '设置 VERSION=1' : '修正为 VERSION=2'], {
  cwd: process.cwd()
})

writeFileSync(
  join(outDir, 'result.json'),
  JSON.stringify(
    {
      status: 'success',
      summary: firstRound
        ? '已将 NOTES.md 写为 VERSION=1。验证:cat NOTES.md 确认内容。'
        : '按审查意见修正 NOTES.md 为 VERSION=2。验证:cat NOTES.md 确认内容。',
      files_changed: ['NOTES.md'],
      notes: firstRound ? '' : '已按审查意见逐条处理',
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString()
    },
    null,
    2
  )
)
