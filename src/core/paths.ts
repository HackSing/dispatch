import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

/** 测试与多实例隔离统一走 DISPATCH_HOME 环境变量,业务代码禁止直连 ~/.dispatch */
export function dispatchHome(): string {
  return process.env.DISPATCH_HOME ?? join(homedir(), '.dispatch')
}

export interface DispatchPaths {
  home: string
  configFile: string
  dbFile: string
  promptsDir: string
  worktreesDir: string
  archivesDir: string
  reportsDir: string
  logsDir: string
}

export function resolvePaths(home: string = dispatchHome()): DispatchPaths {
  return {
    home,
    configFile: join(home, 'config.json'),
    dbFile: join(home, 'dispatch.db'),
    promptsDir: join(home, 'prompts'),
    worktreesDir: join(home, 'worktrees'),
    archivesDir: join(home, 'archives'),
    reportsDir: join(home, 'reports'),
    logsDir: join(home, 'logs')
  }
}

export function ensureDispatchDirs(paths: DispatchPaths): void {
  for (const dir of [
    paths.home,
    paths.promptsDir,
    paths.worktreesDir,
    paths.archivesDir,
    paths.reportsDir,
    paths.logsDir
  ]) {
    mkdirSync(dir, { recursive: true })
  }
}
