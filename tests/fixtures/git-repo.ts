import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 临时 git 仓库工厂:init + 首提交,身份与签名配置写进仓库级 config,worktree 共享 */

export function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
}

export function makeGitRepo(prefix = 'dispatch-repo-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  git(dir, ['init', '-b', 'main'])
  git(dir, ['config', 'user.name', 'Dispatch Test'])
  git(dir, ['config', 'user.email', 'test@dispatch.local'])
  git(dir, ['config', 'commit.gpgsign', 'false'])
  commitFile(dir, 'file.txt', 'base', 'init')
  return dir
}

export function commitFile(dir: string, file: string, content: string, message: string): void {
  writeFileSync(join(dir, file), content + '\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-m', message])
}

/** 造脏区:未提交的已跟踪文件改动 */
export function makeDirty(dir: string, file = 'file.txt'): void {
  writeFileSync(join(dir, file), 'dirty uncommitted change\n')
}

export function headOf(dir: string, ref = 'HEAD'): string {
  return git(dir, ['rev-parse', ref]).trim()
}

export function branchExists(dir: string, branch: string): boolean {
  return git(dir, ['branch', '--list', branch]).trim().length > 0
}

export function logOneline(dir: string, ref = 'HEAD'): string {
  return git(dir, ['log', '--oneline', ref])
}
