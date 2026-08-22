import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { sanitizeName, taskBranchName } from '@core/naming'

const GIT_MAX_BUFFER = 10 * 1024 * 1024

export class GitError extends Error {
  constructor(
    public readonly args: string[],
    public readonly cwd: string,
    public readonly stderr: string,
    public readonly exitCode: number | null
  ) {
    super(`git ${args.join(' ')} 失败 (exit ${exitCode ?? 'spawn'}) @ ${cwd}: ${stderr.trim()}`)
    this.name = 'GitError'
  }
}

interface GitRawResult {
  code: number
  stdout: string
  stderr: string
}

/** 非零退出不抛(供 merge 等需要检视失败的调用),spawn 失败仍抛 GitError */
function gitRaw(args: string[], cwd: string): Promise<GitRawResult> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: GIT_MAX_BUFFER }, (err, stdout, stderr) => {
      if (err && typeof err.code !== 'number') {
        reject(new GitError(args, cwd, stderr || err.message, null))
      } else {
        resolve({ code: err ? (err.code as number) : 0, stdout, stderr })
      }
    })
  })
}

/** 任何非零退出都带 stderr 抛 GitError */
async function git(args: string[], cwd: string): Promise<string> {
  const r = await gitRaw(args, cwd)
  if (r.code !== 0) throw new GitError(args, cwd, r.stderr, r.code)
  return r.stdout
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const r = await gitRaw(['rev-parse', '--is-inside-work-tree'], dir)
    return r.code === 0 && r.stdout.trim() === 'true'
  } catch {
    return false
  }
}

/** detached HEAD 返回 'HEAD',由调用方决定拒绝 */
export async function currentBranch(dir: string): Promise<string> {
  return (await git(['rev-parse', '--abbrev-ref', 'HEAD'], dir)).trim()
}

/** W1b 追加:当前 HEAD 提交 sha,工作流审查阶段前后快照对比用 */
export async function headSha(dir: string): Promise<string> {
  return (await git(['rev-parse', 'HEAD'], dir)).trim()
}

/** W1b 追加:status --porcelain 原文(含未跟踪文件),工作流审查阶段前后快照对比用 */
export async function statusPorcelain(dir: string): Promise<string> {
  return git(['status', '--porcelain'], dir)
}

/** porcelain 输出非空即脏(含未跟踪文件,宁可误停不可误合) */
export async function isDirty(dir: string): Promise<boolean> {
  return (await statusPorcelain(dir)).trim().length > 0
}

export interface CreateWorktreeOptions {
  projectPath: string
  worktreesDir: string
  projectName: string
  taskId: string
  taskText: string
  baseBranch: string
}

export interface WorktreeInfo {
  worktreePath: string
  branch: string
}

/** worktrees/<project>/<task-id>/,基于执行时刻 base 分支最新提交建分支 */
export async function createTaskWorktree(o: CreateWorktreeOptions): Promise<WorktreeInfo> {
  const worktreePath = join(o.worktreesDir, sanitizeName(o.projectName), o.taskId)
  mkdirSync(dirname(worktreePath), { recursive: true })
  const branch = taskBranchName(o.taskId, o.taskText)
  await git(['worktree', 'add', worktreePath, '-b', branch, o.baseBranch], o.projectPath)
  return { worktreePath, branch }
}

export interface MergeFlowOptions {
  projectPath: string
  worktreePath: string
  baseBranch: string
  branch: string
}

export type MergeOutcome =
  | { kind: 'merged'; mode: 'update_ref' | 'ff_forward' }
  | { kind: 'conflict'; files: string[] }
  | { kind: 'awaiting_merge'; reason: 'base_dirty' | 'base_checked_out_elsewhere' }

/**
 * spec §7.3 + dev-plan §0 修正 2:先在 task worktree 内 merge base(冲突即 abort),
 * 干净后依 base 检出位置三分支推进,全程不改动用户主工作区内容。
 */
export async function mergeFlow(o: MergeFlowOptions): Promise<MergeOutcome> {
  const merge = await gitRaw(['merge', '--no-edit', o.baseBranch], o.worktreePath)
  if (merge.code !== 0) {
    const unmerged = await git(['diff', '--name-only', '--diff-filter=U'], o.worktreePath)
    const files = unmerged.split('\n').filter((f) => f.length > 0)
    if (files.length === 0) {
      throw new GitError(
        ['merge', '--no-edit', o.baseBranch],
        o.worktreePath,
        merge.stderr,
        merge.code
      )
    }
    await git(['merge', '--abort'], o.worktreePath)
    return { kind: 'conflict', files }
  }
  return advanceBase(o)
}

interface WorktreeEntry {
  path: string
  branch: string | null
}

function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let current: WorktreeEntry | null = null
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: null }
      entries.push(current)
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length)
    }
  }
  return entries
}

/** 首条 worktree 即主工作区(git 保证);被 worktree 检出的分支禁止 update-ref 硬移 */
async function advanceBase(o: MergeFlowOptions): Promise<MergeOutcome> {
  const entries = parseWorktreeList(await git(['worktree', 'list', '--porcelain'], o.projectPath))
  const holder = entries.find((e) => e.branch === `refs/heads/${o.baseBranch}`)
  if (!holder) {
    const sha = (await git(['rev-parse', `refs/heads/${o.branch}`], o.worktreePath)).trim()
    await git(['update-ref', `refs/heads/${o.baseBranch}`, sha], o.projectPath)
    return { kind: 'merged', mode: 'update_ref' }
  }
  if (holder !== entries[0]) return { kind: 'awaiting_merge', reason: 'base_checked_out_elsewhere' }
  if (await isDirty(holder.path)) return { kind: 'awaiting_merge', reason: 'base_dirty' }
  await git(['merge', '--ff-only', o.branch], holder.path)
  return { kind: 'merged', mode: 'ff_forward' }
}

/** prepare_cmd 会在 worktree 留下未跟踪产物(如 node_modules),必须 --force */
export async function removeWorktree(
  projectPath: string,
  worktreePath: string,
  branch: string
): Promise<void> {
  await git(['worktree', 'remove', '--force', worktreePath], projectPath)
  await git(['branch', '-D', branch], projectPath)
}

export interface ConflictReportOptions {
  archiveDir: string
  worktreePath: string
  baseBranch: string
  branch: string
  files: string[]
}

async function logOnly(worktreePath: string, include: string, exclude: string): Promise<string> {
  const out = await git(
    ['log', '--oneline', '--no-decorate', '--max-count=20', include, `^${exclude}`],
    worktreePath
  )
  return out.trim() || '(无独有提交)'
}

/** archive_dir/conflict-report.md:冲突文件、双方提交摘要、worktree 路径与处理指引 */
export async function writeConflictReport(o: ConflictReportOptions): Promise<string> {
  const taskLog = await logOnly(o.worktreePath, 'HEAD', o.baseBranch)
  const baseLog = await logOnly(o.worktreePath, o.baseBranch, 'HEAD')
  const md = [
    '# 合并冲突报告',
    '',
    `- 任务分支: ${o.branch}`,
    `- base 分支: ${o.baseBranch}`,
    `- worktree: ${o.worktreePath}`,
    '',
    '## 冲突文件',
    '',
    ...o.files.map((f) => `- ${f}`),
    '',
    `## 任务分支独有提交(${o.branch})`,
    '',
    '```',
    taskLog,
    '```',
    '',
    `## base 分支独有提交(${o.baseBranch})`,
    '',
    '```',
    baseLog,
    '```',
    '',
    '## 处理指引',
    '',
    `1. 进入 worktree 目录:\`cd ${o.worktreePath}\``,
    `2. 手动执行 \`git merge ${o.baseBranch}\`,解决上述文件冲突并提交。`,
    '3. 回到 Dispatch 点「重试合并」;或放弃该任务(worktree 与分支将按清理策略回收)。',
    ''
  ].join('\n')
  const file = join(o.archiveDir, 'conflict-report.md')
  writeFileSync(file, md, 'utf-8')
  return file
}
