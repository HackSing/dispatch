import { spawn } from 'node:child_process'

/** 跨平台 shell 调用形状(B5 批1):POSIX 走 /bin/sh -c,win32 走 cmd.exe /d /s /c */
const IS_WIN32 = process.platform === 'win32'

interface ShellInvocation {
  file: string
  args: (cmd: string) => string[]
  /** win32:cmd 串是用户为本平台写的配置,原样透传不做转义;windowsHide 防弹控制台窗口 */
  options: { windowsVerbatimArguments?: boolean; windowsHide?: boolean }
}

const SHELL_INVOCATION: ShellInvocation = IS_WIN32
  ? {
      file: 'cmd.exe',
      args: (cmd) => ['/d', '/s', '/c', cmd],
      options: { windowsVerbatimArguments: true, windowsHide: true }
    }
  : { file: '/bin/sh', args: (cmd) => ['-c', cmd], options: {} }

export interface RunShellOptions {
  cwd?: string
  onLog?: (chunk: string) => void
  env?: NodeJS.ProcessEnv
}

export interface ShellResult {
  exitCode: number
  stdout: string
  stderr: string
}

/** 非零退出不抛错(由调用方决策),spawn 本身失败才 reject */
export function runShell(cmd: string, opts: RunShellOptions = {}): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(SHELL_INVOCATION.file, SHELL_INVOCATION.args(cmd), {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...SHELL_INVOCATION.options
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => {
      const text = c.toString()
      stdout += text
      opts.onLog?.(text)
    })
    child.stderr.on('data', (c: Buffer) => {
      const text = c.toString()
      stderr += text
      opts.onLog?.(text)
    })
    child.once('error', (e) => reject(new Error(`shell 命令启动失败: ${cmd}: ${e.message}`)))
    child.once('close', (code) => resolve({ exitCode: code ?? -1, stdout, stderr }))
  })
}

/** 拉起守护类进程:不等待退出,与本进程解绑 */
export function spawnShellDetached(cmd: string, cwd?: string): void {
  const child = spawn(SHELL_INVOCATION.file, SHELL_INVOCATION.args(cmd), {
    cwd,
    detached: true,
    stdio: 'ignore',
    ...SHELL_INVOCATION.options
  })
  child.once('error', () => {
    // 守护进程拉起失败由后续 ready_check 轮询超时暴露
  })
  child.unref()
}
