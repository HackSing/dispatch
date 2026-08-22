import { spawn } from 'node:child_process'

/** POSIX shell;B5 Windows 需在此扩展 cmd.exe 分支(见 dev-plan §4 B5) */
const SHELL = '/bin/sh'

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
    const child = spawn(SHELL, ['-c', cmd], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe']
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
  const child = spawn(SHELL, ['-c', cmd], { cwd, detached: true, stdio: 'ignore' })
  child.once('error', () => {
    // 守护进程拉起失败由后续 ready_check 轮询超时暴露
  })
  child.unref()
}
