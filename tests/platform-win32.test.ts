import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SpawnPlan } from '@core/platform'
import { escapeCmdArg, pickExecutable, win32Ops } from '@core/platform/win32'

const TREE_SCRIPT = fileURLToPath(new URL('./fixtures/spawn-tree.cjs', import.meta.url))
const DUMP_ARGV_SCRIPT = fileURLToPath(new URL('./fixtures/dump-argv.cjs', import.meta.url))

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dispatch-win32-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 按 plan 真实执行,收集 stdout;非零退出 reject 附 stderr */
function runPlan(plan: SpawnPlan): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(plan.file, plan.args, {
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()))
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()))
    child.once('error', reject)
    child.once('close', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`退出码 ${code}: ${stderr}`))
    )
  })
}

async function waitDead(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    if (Date.now() > deadline) throw new Error(`pid ${pid} 在等待窗口内未退出`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe.runIf(process.platform === 'win32')('win32 platform ops', () => {
  describe('findBinary', () => {
    it('git 返回以 .exe 结尾的存在路径', async () => {
      const bin = await win32Ops.findBinary('git')
      expect(bin).not.toBeNull()
      expect(bin!.toLowerCase()).toMatch(/\.exe$/)
      expect(existsSync(bin!)).toBe(true)
    })

    it('不存在的命令返回 null', async () => {
      await expect(win32Ops.findBinary('绝不存在的命令xyz')).resolves.toBeNull()
    })
  })

  describe('killTree', () => {
    it('taskkill /T /F 强杀父与孙进程', async () => {
      const pidsFile = join(dir, 'pids.json')
      spawn(process.execPath, [TREE_SCRIPT, pidsFile], { stdio: 'ignore' })
      const deadline = Date.now() + 10_000
      while (!existsSync(pidsFile)) {
        if (Date.now() > deadline) throw new Error('fixture 未在等待窗口内写出 pid 文件')
        await new Promise((r) => setTimeout(r, 50))
      }
      const { parent, child } = JSON.parse(readFileSync(pidsFile, 'utf-8'))
      await win32Ops.killTree(parent)
      await waitDead(parent)
      await waitDead(child)
    }, 30_000)

    it('进程已退出时静默返回(best-effort)', async () => {
      const { parent } = await new Promise<{ parent: number }>((resolve, reject) => {
        const pidsFile = join(dir, 'pids2.json')
        spawn(process.execPath, [TREE_SCRIPT, pidsFile], { stdio: 'ignore' })
        const timer = setInterval(() => {
          if (existsSync(pidsFile)) {
            clearInterval(timer)
            resolve(JSON.parse(readFileSync(pidsFile, 'utf-8')))
          }
        }, 50)
        setTimeout(() => {
          clearInterval(timer)
          reject(new Error('fixture 未在等待窗口内写出 pid 文件'))
        }, 10_000)
      })
      await win32Ops.killTree(parent)
      await waitDead(parent)
      await expect(win32Ops.killTree(parent)).resolves.toBeUndefined()
    }, 30_000)
  })

  describe('pickExecutable(纯函数,审查 R1)', () => {
    it('npm 全局布局:跳过无扩展名 sh 脚本,选第一个 .cmd', () => {
      // 本机 where codex 真实输出
      const lines = [
        'C:\\Users\\freed\\AppData\\Roaming\\npm-codex-latest\\codex',
        'C:\\Users\\freed\\AppData\\Roaming\\npm-codex-latest\\codex.cmd',
        'C:\\Users\\freed\\AppData\\Roaming\\npm\\codex',
        'C:\\Users\\freed\\AppData\\Roaming\\npm\\codex.cmd'
      ]
      expect(pickExecutable(lines)).toBe(
        'C:\\Users\\freed\\AppData\\Roaming\\npm-codex-latest\\codex.cmd'
      )
    })

    it('全部行都不可执行 → null(如实报告,不返回跑不起来的路径)', () => {
      expect(pickExecutable(['C:\\tools\\agent', 'C:\\tools\\agent.ps1', ''])).toBeNull()
    })

    it('.exe 优先于靠后的 .cmd,空行与空白行跳过', () => {
      expect(pickExecutable(['', '  ', 'C:\\tools\\a.exe', 'C:\\tools\\a.cmd'])).toBe(
        'C:\\tools\\a.exe'
      )
    })
  })

  describe('buildSpawn', () => {
    it('.exe 路径恒等透传', () => {
      expect(win32Ops.buildSpawn('C:\\Tools\\git.exe', ['--version'])).toEqual({
        file: 'C:\\Tools\\git.exe',
        args: ['--version']
      })
    })

    it('.cmd 经 cmd.exe 包装,特殊参数真实执行后无损到达', async () => {
      const shim = join(dir, 'echo-args.cmd')
      writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${DUMP_ARGV_SCRIPT}" %*\r\n`)
      const args = ['hello world', 'say "hi"', '中文参数', '%PATH%', 'a&b', 'caret^here']
      const plan = win32Ops.buildSpawn(shim, args)
      expect(plan.file).toBe('cmd.exe')
      expect(plan.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
      expect(plan.windowsVerbatimArguments).toBe(true)
      const stdout = await runPlan(plan)
      expect(JSON.parse(stdout)).toEqual(args)
    }, 30_000)

    it('含换行的参数直接 throw,不静默截断', () => {
      expect(() => win32Ops.buildSpawn('C:\\x\\a.cmd', ['a\nb'])).toThrow(/换行/)
    })
  })

  describe('escapeCmdArg(纯函数)', () => {
    it('整体加引号,cmd 元字符逐个 ^ 前缀', () => {
      expect(escapeCmdArg('plain', false)).toBe('^"plain^"')
      expect(escapeCmdArg('a b', false)).toBe('^"a^ b^"')
      expect(escapeCmdArg('a&b', false)).toBe('^"a^&b^"')
      expect(escapeCmdArg('100%', false)).toBe('^"100^%^"')
      expect(escapeCmdArg('caret^here', false)).toBe('^"caret^^here^"')
    })

    it('doubleEscapeMetaChars:元字符与 ^ 自身再 ^ 转义一遍(批处理 %* 二次解析)', () => {
      expect(escapeCmdArg('a&b', true)).toBe('^^^"a^^^&b^^^"')
      expect(escapeCmdArg('100%', true)).toBe('^^^"100^^^%^^^"')
    })

    it('内部双引号按 MSVCRT 转 \\"', () => {
      expect(escapeCmdArg('say "hi"', false)).toBe('^"say^ \\^"hi\\^"^"')
    })

    it('末尾反斜杠在闭合引号前加倍', () => {
      expect(escapeCmdArg('C:\\', false)).toBe('^"C:\\\\^"')
    })

    it('含换行直接 throw', () => {
      expect(() => escapeCmdArg('a\rb', false)).toThrow(/换行/)
    })
  })
})
