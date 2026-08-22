/**
 * 会话寻址的占位渲染与能力判定单点。模板来自 AgentConfig 三件套
 * (session_args / resume_headless_args / interactive_resume_cmd),
 * 与 agent id 无关(spec §5.2 配置驱动原则)。
 */

import type { AgentConfig } from '@core/config'

export const SESSION_ID_PLACEHOLDER = '{SESSION_ID}'

/** 模板含占位符但未提供 sessionId 属调用方契约违约,立即抛错而非静默透传 */
export function renderSessionArgs(args: readonly string[], sessionId?: string): string[] {
  return args.map((arg) => {
    if (!arg.includes(SESSION_ID_PLACEHOLDER)) return arg
    if (!sessionId) throw new Error(`参数模板含 ${SESSION_ID_PLACEHOLDER} 但未提供 sessionId: ${arg}`)
    return arg.replaceAll(SESSION_ID_PLACEHOLDER, sessionId)
  })
}

/**
 * 运行期基础 argv(auto_approve_args 与 prompt 之外的部分):
 * - fresh run:[session_args 渲染, ...headless_args](session_args 前置,
 *   保住 kimi「prompt flag 必须是最后一个 flag」的既有约束);
 * - resume run:resume_headless_args 渲染后整体替换 headless_args,未配置即抛错。
 */
export function buildBaseArgs(
  agentId: string,
  config: AgentConfig,
  opts: { resume?: boolean; sessionId?: string }
): string[] {
  if (opts.resume) {
    if (!supportsResume(config)) {
      throw new Error(`agent ${agentId} 未配置 resume_headless_args,不支持续会话运行`)
    }
    return renderSessionArgs(config.resume_headless_args, opts.sessionId)
  }
  return [...renderSessionArgs(config.session_args, opts.sessionId), ...config.headless_args]
}

/** fresh run 可预生成会话 id(sessionId 值得落库) */
export function supportsSession(config: AgentConfig): boolean {
  return config.session_args.length > 0
}

/** 已有会话可 headless 续跑(追问/接力任务的前置) */
export function supportsResume(config: AgentConfig): boolean {
  return supportsSession(config) && config.resume_headless_args.length > 0
}

/** 终端逃生舱可用(交互式 resume 命令已校准) */
export function supportsTerminalResume(config: AgentConfig): boolean {
  return supportsSession(config) && config.interactive_resume_cmd !== null
}
