import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { extname, isAbsolute } from 'node:path'
import type { PlatformOps, SpawnPlan } from './index'

// 转义算法移植自 node_modules/cross-spawn/lib/util/escape.js(生产验证实现,见
// https://qntm.org/cmd),未自行推导;批处理经 %* 转发会对参数再解析一次,
// 故目标是 .cmd/.bat 时按 cross-spawn parse.js 的做法二次 ^ 转义。
// See http://www.robvanderwoude.com/escapechars.php
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

/** 含 \r/\n 的参数无法安全穿过 cmd.exe:显式暴露,不静默截断 */
function assertNoNewline(value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(
      'Windows 上 .cmd/.bat shim 不支持含换行的参数,' +
        '建议安装原生 exe 版本或将该 agent 的 prompt_via 配置为 stdin'
    )
  }
}

/** 命令路径转义(移植 cross-spawn escapeCommand):不加引号,元字符逐个 ^ 前缀 */
export function escapeCmdCommand(binPath: string): string {
  assertNoNewline(binPath)
  return binPath.replace(CMD_META, '^$1')
}

/**
 * 参数转义(移植 cross-spawn escapeArgument,纯函数导出供单测):
 * 按 MSVCRT 规则处理反斜杠与引号(引号前反斜杠加倍、内部 " 转 \"、末尾反斜杠加倍),
 * 整体加引号后 ^ 转义元字符;doubleEscapeMetaChars 时再 ^ 转义一遍(批处理二次解析)。
 */
export function escapeCmdArg(arg: string, doubleEscapeMetaChars: boolean): string {
  assertNoNewline(arg)
  // Sequence of backslashes followed by a double quote:
  // double up all the backslashes and escape the double quote
  let s = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
  // Sequence of backslashes followed by the end of the string
  // (which will become a double quote later): double up all the backslashes
  s = s.replace(/(?=(\\+?)?)\1$/, '$1$1')
  // All other backslashes occur literally;quote the whole thing
  s = `"${s}"`
  s = s.replace(CMD_META, '^$1')
  if (doubleEscapeMetaChars) s = s.replace(CMD_META, '^$1')
  return s
}

/** cmd 可执行的扩展名集合(审查 R1):where 首行常是无扩展名 sh 脚本,cmd 无法执行 */
const EXECUTABLE_EXTS = new Set(['.exe', '.com', '.cmd', '.bat'])

/**
 * 从 where 输出选第一个可执行行(纯函数,导出供单测):
 * 取第一个扩展名属于 .exe/.com/.cmd/.bat 的非空行;全部不可执行时返回 null
 * (如实报告找不到,不返回跑不起来的路径)。
 */
export function pickExecutable(lines: string[]): string | null {
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length > 0 && EXECUTABLE_EXTS.has(extname(trimmed).toLowerCase())) {
      return trimmed
    }
  }
  return null
}

/** .exe/.com 可由 CreateProcess 直接执行;.cmd/.bat 等 shim 必须经 cmd.exe */
function isDirectExecutable(binPath: string): boolean {
  const ext = extname(binPath).toLowerCase()
  return ext === '.exe' || ext === '.com'
}

/**
 * 转成可直接 spawn/execFile 的调用形状。
 * CVE-2024-27980 后 Node 不带 shell 无法执行 .cmd/.bat(EINVAL),统一走
 * cmd.exe /d /s /c "<转义后的完整命令行>" + windowsVerbatimArguments(对齐 cross-spawn)。
 */
function buildSpawn(binPath: string, args: string[]): SpawnPlan {
  if (isDirectExecutable(binPath)) return { file: binPath, args }
  const isCmdFile = ['.cmd', '.bat'].includes(extname(binPath).toLowerCase())
  const cmdLine = [escapeCmdCommand(binPath), ...args.map((a) => escapeCmdArg(a, isCmdFile))].join(
    ' '
  )
  return {
    file: 'cmd.exe',
    args: ['/d', '/s', '/c', `"${cmdLine}"`],
    windowsVerbatimArguments: true
  }
}

export const win32Ops: PlatformOps = {
  /** taskkill /T /F 即强杀整树;进程已退出时 taskkill 非零退出,静默返回(对齐 darwin best-effort 语义) */
  killTree(pid: number): Promise<void> {
    return new Promise((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve())
    })
  },

  /** where 输出顺序即 cmd 解析顺序;从中选第一个可执行行(无扩展名 sh 脚本跳过) */
  findBinary(name: string): Promise<string | null> {
    // where 拒绝含路径分隔符的输入(Invalid pattern):路径形态直接按存在性判定
    if (isAbsolute(name) || name.includes('\\') || name.includes('/')) {
      return Promise.resolve(existsSync(name) ? name : null)
    }
    return new Promise((resolve) => {
      execFile('where', [name], (err, stdout) => {
        if (err) return resolve(null)
        resolve(pickExecutable(stdout.split(/\r?\n/)))
      })
    })
  },

  /** start 拉起新 cmd 窗口 /k 驻留执行用户命令串;cwd 加引号处理含空格路径 */
  openTerminal(cwd: string, command: string): Promise<void> {
    const line = `start "Dispatch" /d "${cwd}" cmd /k ${command}`
    return new Promise((resolve, reject) => {
      execFile(
        'cmd.exe',
        ['/d', '/s', '/c', line],
        { windowsVerbatimArguments: true },
        (err, _stdout, stderr) => {
          if (err) reject(new Error(`打开终端失败: ${stderr.trim() || err.message}`))
          else resolve()
        }
      )
    })
  },

  buildSpawn
}
