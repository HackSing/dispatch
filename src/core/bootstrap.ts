import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProjectStore } from './db/project-store'
import type { Project } from '@shared/types'

export const DEFAULT_PROJECT_ID = 'default'

/** 不放 ~/Documents / ~/Desktop:iCloud 同步与 git 仓库有已知冲突(dev-plan §0) */
export function defaultProjectDir(): string {
  return join(homedir(), 'Dispatch', 'default')
}

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(' ')} 失败: ${stderr.trim() || err.message}`))
      else resolve()
    })
  })
}

function hasCommit(cwd: string): Promise<boolean> {
  return git(cwd, ['rev-parse', '--verify', 'HEAD']).then(
    () => true,
    () => false
  )
}

export interface SeedResult {
  created: boolean
  project: Project
}

/**
 * 首启种子 default 项目。幂等:项目行已存在则整体跳过。
 * git 初始化失败时抛错、不写项目行——default 项目必须走 worktree 隔离,不允许静默降级为 no_vcs。
 */
export async function seedDefaultProject(
  projects: ProjectStore,
  dir: string = defaultProjectDir()
): Promise<SeedResult> {
  const existing = projects.get(DEFAULT_PROJECT_ID)
  if (existing) return { created: false, project: existing }

  mkdirSync(dir, { recursive: true })
  if (!existsSync(join(dir, '.git'))) {
    await git(dir, ['init'])
  }
  if (!(await hasCommit(dir))) {
    await git(dir, [
      '-c',
      'user.name=Dispatch',
      '-c',
      'user.email=dispatch@localhost',
      'commit',
      '--allow-empty',
      '-m',
      'chore: Dispatch default 项目初始化'
    ])
  }
  const project = projects.create({ id: DEFAULT_PROJECT_ID, name: 'default', path: dir })
  return { created: true, project }
}
