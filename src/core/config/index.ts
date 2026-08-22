import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { z } from 'zod'

/**
 * Agent CLI 调用参数全部配置化(spec §5.2 原则):代码中不允许出现 agent 特有分支。
 * calibrated 记录参数校准时点与 CLI 版本,检测到版本漂移时 UI 提示重校准。
 */
export const AgentConfigSchema = z.object({
  bin: z.string(),
  headless_args: z.array(z.string()).default([]),
  auto_approve_args: z.array(z.string()).default([]),
  prompt_via: z.enum(['arg', 'stdin']).default('arg'),
  version_args: z.array(z.string()).default(['--version']),
  ready_check_cmd: z.string().nullable().default(null),
  start_cmd: z.string().nullable().default(null),
  /** 输出日志过滤器名,见 core/agents/log-filters.ts;null = 原样落盘 */
  log_filter: z.enum(['claude_stream_json']).nullable().default(null),
  calibrated: z
    .object({ date: z.string(), cli_version: z.string() })
    .nullable()
    .default(null)
})

export type AgentConfig = z.infer<typeof AgentConfigSchema>

const AgentsRecordSchema = z.record(z.string(), AgentConfigSchema)

const DEFAULT_AGENTS: Record<string, z.input<typeof AgentConfigSchema>> = {
  'claude-code': {
    bin: 'claude',
    headless_args: ['-p', '--output-format', 'stream-json', '--verbose'],
    auto_approve_args: ['--dangerously-skip-permissions'],
    log_filter: 'claude_stream_json',
    calibrated: { date: '2026-08-22', cli_version: '2.1.229' }
  },
  codex: { bin: 'codex', headless_args: ['exec'] },
  dsh: { bin: 'dsh' },
  kimi: { bin: 'kimi' },
  qwen: { bin: 'qwen' }
}

export const ConfigSchema = z.object({
  /** CommandOrControl → macOS Cmd / Windows Ctrl,即 dev-plan §0 的双平台默认键 */
  hotkey: z.string().default('CommandOrControl+Shift+Space'),
  max_concurrency: z.number().int().min(1).default(2),
  task_timeout_min: z.number().int().min(1).default(30),
  daily_report_time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .default('21:00'),
  daily_report_notify: z.boolean().default(true),
  missed_task_policy: z.enum(['run', 'skip']).default('run'),
  cleanup_keep_days: z.number().int().min(1).default(14),
  agents: AgentsRecordSchema.default(() => AgentsRecordSchema.parse(DEFAULT_AGENTS))
})

export type DispatchConfig = z.infer<typeof ConfigSchema>

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly file: string
  ) {
    super(`${message} (${file})`)
    this.name = 'ConfigError'
  }
}

/** 文件缺失 → 写入默认并返回;存在 → 校验加载。损坏的配置抛错,不静默覆盖用户文件。 */
export function loadConfig(configFile: string): DispatchConfig {
  if (!existsSync(configFile)) {
    const defaults = ConfigSchema.parse({})
    writeConfig(configFile, defaults)
    return defaults
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(configFile, 'utf-8'))
  } catch (e) {
    throw new ConfigError(`config.json 不是合法 JSON: ${(e as Error).message}`, configFile)
  }
  const parsed = ConfigSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ConfigError(`config.json 校验失败: ${parsed.error.message}`, configFile)
  }
  return parsed.data
}

export function writeConfig(configFile: string, config: DispatchConfig): void {
  writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', 'utf-8')
}
