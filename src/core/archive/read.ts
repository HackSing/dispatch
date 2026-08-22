import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ArchiveFileInfo, TaskArchive } from '@shared/ipc'

/** 日志只取尾部,防止详情页拉全量大文件 */
const LOG_TAIL_BYTES = 16 * 1024

function readIfExists(dir: string, name: string): string | null {
  const file = join(dir, name)
  return existsSync(file) ? readFileSync(file, 'utf-8') : null
}

function readTail(dir: string, name: string): string | null {
  const file = join(dir, name)
  if (!existsSync(file)) return null
  const size = statSync(file).size
  const start = Math.max(0, size - LOG_TAIL_BYTES)
  const buf = Buffer.alloc(size - start)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, buf, 0, buf.length, start)
  } finally {
    closeSync(fd)
  }
  const text = buf.toString('utf-8')
  return start > 0 ? `…(仅显示日志尾部 ${LOG_TAIL_BYTES / 1024}KB)\n${text}` : text
}

function listFiles(archiveDir: string): ArchiveFileInfo[] {
  return readdirSync(archiveDir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => ({ name: e.name, size: statSync(join(archiveDir, e.name)).size }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function readTaskArchive(archiveDir: string | null): TaskArchive {
  if (!archiveDir || !existsSync(archiveDir)) {
    return {
      taskMd: null,
      planMd: null,
      resultRaw: null,
      logTail: null,
      conflictReport: null,
      files: []
    }
  }
  return {
    taskMd: readIfExists(archiveDir, 'task.md'),
    planMd: readIfExists(archiveDir, 'plan.md'),
    resultRaw: readIfExists(archiveDir, 'result.json'),
    logTail: readTail(archiveDir, 'output.log'),
    conflictReport: readIfExists(archiveDir, 'conflict-report.md'),
    files: listFiles(archiveDir)
  }
}
