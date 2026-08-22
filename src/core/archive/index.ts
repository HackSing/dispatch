import { createWriteStream, existsSync, mkdirSync, writeFileSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import type { DispatchPaths } from '@core/paths'
import { sanitizeName, shortId } from '@core/naming'
import type { Project, Task } from '@shared/types'

export type VcsMode = 'git' | 'no_vcs'

export interface CreateArchiveOptions {
  vcs: VcsMode
  now?: Date
}

export interface ArchiveInfo {
  archiveDir: string
  taskMdFile: string
}

const ARCHIVE_SUFFIX_LIMIT = 100

/** 撞名时追加 -2/-3…(recovery 的归档回填匹配同步认识该后缀);上限防御性封顶 */
function firstFreeDir(base: string): string {
  if (!existsSync(base)) return base
  for (let n = 2; n <= ARCHIVE_SUFFIX_LIMIT; n++) {
    const candidate = `${base}-${n}`
    if (!existsSync(candidate)) return candidate
  }
  throw new Error(`归档目录后缀耗尽: ${base}`)
}

/** 归档目录使用本地日期,与用户对「当天任务」的感知一致 */
function formatLocalDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function renderTaskMd(project: Project, task: Task, opts: CreateArchiveOptions): string {
  const trigger = task.triggerType === 'at' ? `at ${task.triggerAt ?? '-'}` : task.triggerType
  return [
    `# 任务 ${task.id}`,
    '',
    `- 项目: ${project.name} (${project.path})`,
    `- 智能体: ${task.agent ?? '-'}`,
    `- 触发: ${trigger}`,
    `- 创建时间: ${task.createdAt}`,
    `- 开始时间: ${task.startedAt ?? '-'}`,
    `- base 分支: ${task.baseBranch ?? '-'}`,
    `- vcs: ${opts.vcs}`,
    '',
    '## 任务原文',
    '',
    task.text,
    ''
  ].join('\n')
}

/** archives/<project-name>/<yyyy-MM-dd>-<task 短 id>/,落 task.md */
export function createArchive(
  paths: DispatchPaths,
  project: Project,
  task: Task,
  opts: CreateArchiveOptions
): ArchiveInfo {
  const date = formatLocalDate(opts.now ?? new Date())
  const base = join(paths.archivesDir, sanitizeName(project.name), `${date}-${shortId(task.id)}`)
  // 同任务同日再次执行(原地重跑)不得复用旧目录:上一轮残留的 result.json 会污染完成判定
  const archiveDir = firstFreeDir(base)
  mkdirSync(archiveDir, { recursive: true })
  const taskMdFile = join(archiveDir, 'task.md')
  writeFileSync(taskMdFile, renderTaskMd(project, task, opts), 'utf-8')
  return { archiveDir, taskMdFile }
}

/** 执行期 stdout/stderr 流式追加落盘,写失败在 close 时抛出,不静默丢日志 */
export class OutputLog {
  private readonly stream: WriteStream
  private error: Error | null = null

  constructor(archiveDir: string) {
    this.stream = createWriteStream(join(archiveDir, 'output.log'), { flags: 'a' })
    this.stream.once('error', (e) => {
      this.error = e
    })
  }

  get file(): string {
    return this.stream.path as string
  }

  append(chunk: string): void {
    if (this.error) return
    this.stream.write(chunk)
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream.end(() => {
        if (this.error) reject(this.error)
        else resolve()
      })
    })
  }
}
