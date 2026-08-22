import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const PROMPT_VARS = ['TASK_TEXT', 'OUT_DIR', 'PROJECT_PATH', 'BASE_BRANCH'] as const
export type PromptVarName = (typeof PROMPT_VARS)[number]
export type PromptVars = Record<PromptVarName, string>

/**
 * 占位模板:正式模板由 resources/prompts/default.md 提供(另一条线产出),
 * 内置文件缺失时以此兜底。OUT_DIR 等键值行是 mock agent 的解析锚点,勿改动格式。
 */
export const FALLBACK_TEMPLATE = `# Dispatch 任务工单(占位模板)

> 本文件由 Dispatch 生成,可编辑;删除后重启应用会从内置模板重新拷贝。

OUT_DIR: {OUT_DIR}
PROJECT_PATH: {PROJECT_PATH}
BASE_BRANCH: {BASE_BRANCH}

## 任务原文

{TASK_TEXT}

## 执行要求(两阶段协议)

1. 动手前先探索仓库、理解任务意图;有歧义时选择最合理假设,假设必须记录在方案中。
2. 把方案写入 {OUT_DIR}/plan.md:任务理解(含假设清单)、执行步骤、涉及文件、风险点。
3. 执行中如需偏离方案,先在 plan.md 追加「变更记录」段落再继续。
4. 结束前把结果写入 {OUT_DIR}/result.json,格式:
   {"status": "success|partial|failed", "summary": "做了什么、结论是什么", "files_changed": [], "follow_up": "", "notes": ""}
5. plan.md 与 result.json 写入上方 OUT_DIR 绝对路径,不要写进仓库工作区。
6. status=success 必须以实际执行过的验证为据;验证跑不了最高只能报 partial。
`

/**
 * promptsDir/default.md 为用户可编辑真源;缺失时从内置模板拷贝一份再读,
 * 内置文件也缺失时落盘占位模板兜底。
 */
export function loadPromptTemplate(promptsDir: string, builtinFile?: string): string {
  const target = join(promptsDir, 'default.md')
  if (!existsSync(target)) {
    mkdirSync(promptsDir, { recursive: true })
    const source =
      builtinFile && existsSync(builtinFile)
        ? readFileSync(builtinFile, 'utf-8')
        : FALLBACK_TEMPLATE
    writeFileSync(target, source, 'utf-8')
  }
  return readFileSync(target, 'utf-8')
}

const VAR_PATTERN = new RegExp(`\\{(${PROMPT_VARS.join('|')})\\}`, 'g')

/** 只替换四个已知变量,未知 {VAR} 原样保留 */
export function renderPrompt(template: string, vars: PromptVars): string {
  return template.replace(VAR_PATTERN, (_, name: PromptVarName) => vars[name])
}
