import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import { AGENT_IDS } from '@shared/types'
import type { UiState } from '@shared/ipc'

/** 机器管理文件,非用户手写配置:缺失/损坏一律静默重建,禁止照 config 抛错 */
const UiStateSchema = z.object({
  lastAgent: z.enum(AGENT_IDS).nullable().default(null),
  lastSubAgent: z.enum(AGENT_IDS).nullable().default(null),
  lastProjectId: z.string().nullable().default(null)
})

function defaults(): UiState {
  return UiStateSchema.parse({})
}

export function loadUiState(file: string): UiState {
  if (!existsSync(file)) {
    const state = defaults()
    writeUiState(file, state)
    return state
  }
  try {
    const parsed = UiStateSchema.safeParse(JSON.parse(readFileSync(file, 'utf-8')))
    if (parsed.success) return parsed.data
  } catch {
    // 损坏走下方重建
  }
  const state = defaults()
  writeUiState(file, state)
  return state
}

export function saveUiState(file: string, patch: Partial<UiState>): UiState {
  const next = { ...loadUiState(file) }
  if (patch.lastAgent !== undefined) next.lastAgent = patch.lastAgent
  if (patch.lastSubAgent !== undefined) next.lastSubAgent = patch.lastSubAgent
  if (patch.lastProjectId !== undefined) next.lastProjectId = patch.lastProjectId
  writeUiState(file, next)
  return next
}

function writeUiState(file: string, state: UiState): void {
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf-8')
}
