/** 归档目录与任务分支共用的命名规则,worktree/archive 路径段必须经此清洗 */

export function sanitizeName(name: string): string {
  const cleaned = name.replace(/[/\\:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned.length > 0 ? cleaned : 'unnamed'
}

export function shortId(id: string): string {
  return id.slice(0, 8)
}

const SLUG_WORD_LIMIT = 4
const SLUG_MAX_LENGTH = 30

/** 任务文本前几词转 ascii-kebab;无 ascii 可用内容时返回空串,由调用方回退短 id */
export function taskSlug(text: string): string {
  const words = text.trim().split(/\s+/).slice(0, SLUG_WORD_LIMIT)
  const slug = words
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.slice(0, SLUG_MAX_LENGTH).replace(/-+$/, '')
}

export function taskBranchName(taskId: string, taskText: string): string {
  const slug = taskSlug(taskText)
  const id = shortId(taskId)
  return slug.length > 0 ? `task/${id}-${slug}` : `task/${id}`
}
