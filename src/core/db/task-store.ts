import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { AgentId, Task, TriggerType } from '@shared/types'
import { assertTransition, type TaskStatus } from '@shared/state-machine'

interface TaskRow {
  id: string
  created_at: string
  text: string
  project_id: string
  agent: string | null
  trigger_type: string
  trigger_at: string | null
  status: string
  base_branch: string | null
  branch: string | null
  worktree_path: string | null
  archive_dir: string | null
  fail_reason: string | null
  scheduled_at: string | null
  started_at: string | null
  finished_at: string | null
  merged_at: string | null
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    createdAt: row.created_at,
    text: row.text,
    projectId: row.project_id,
    agent: row.agent as AgentId | null,
    triggerType: row.trigger_type as TriggerType,
    triggerAt: row.trigger_at,
    status: row.status as TaskStatus,
    baseBranch: row.base_branch,
    branch: row.branch,
    worktreePath: row.worktree_path,
    archiveDir: row.archive_dir,
    failReason: row.fail_reason,
    scheduledAt: row.scheduled_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    mergedAt: row.merged_at
  }
}

export interface CreateTaskInput {
  text: string
  projectId: string
  agent?: AgentId | null
  triggerType: TriggerType
  triggerAt?: string | null
}

/** B1 追加:updateEditable() 可更新的字段,限 todo/scheduled 状态 */
export interface EditableTaskPatch {
  text?: string
  projectId?: string
  agent?: AgentId | null
  triggerType?: TriggerType
  triggerAt?: string | null
}

/** 迁移时可一并更新的执行期字段(状态之外的写入也必须经 transition 收口) */
export interface TransitionPatch {
  failReason?: string | null
  baseBranch?: string | null
  branch?: string | null
  worktreePath?: string | null
  archiveDir?: string | null
  scheduledAt?: string | null
  startedAt?: string | null
  finishedAt?: string | null
  mergedAt?: string | null
}

/** B3 追加:崩溃恢复回填孤儿 worktree 的运行期路径,见 attachRuntimePaths() */
export interface RuntimePathsPatch {
  worktreePath?: string | null
  branch?: string | null
  archiveDir?: string | null
}

const RUNTIME_PATH_COLUMNS: Record<keyof RuntimePathsPatch, string> = {
  worktreePath: 'worktree_path',
  branch: 'branch',
  archiveDir: 'archive_dir'
}

const RUNTIME_PATH_STATUSES = ['failed', 'conflict', 'awaiting_merge'] as const

const PATCH_COLUMNS: Record<keyof TransitionPatch, string> = {
  failReason: 'fail_reason',
  baseBranch: 'base_branch',
  branch: 'branch',
  worktreePath: 'worktree_path',
  archiveDir: 'archive_dir',
  scheduledAt: 'scheduled_at',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
  mergedAt: 'merged_at'
}

/** 任务的唯一写入口。状态变更集中于 transition(),onChange 供 shell 层接 IPC 广播与系统通知。 */
export class TaskStore {
  constructor(
    private readonly db: Database,
    private readonly onChange?: (task: Task) => void
  ) {}

  create(input: CreateTaskInput): Task {
    if (input.triggerType !== 'none' && !input.agent) {
      throw new Error('可执行任务(trigger ≠ none)必须指定 agent')
    }
    if (input.triggerType === 'at' && !input.triggerAt) {
      throw new Error('定时任务必须提供 triggerAt')
    }
    const now = new Date().toISOString()
    const task: Task = {
      id: randomUUID(),
      createdAt: now,
      text: input.text,
      projectId: input.projectId,
      agent: input.agent ?? null,
      triggerType: input.triggerType,
      triggerAt: input.triggerType === 'at' ? (input.triggerAt ?? null) : null,
      status: input.triggerType === 'none' ? 'todo' : 'scheduled',
      baseBranch: null,
      branch: null,
      worktreePath: null,
      archiveDir: null,
      failReason: null,
      scheduledAt: input.triggerType === 'none' ? null : now,
      startedAt: null,
      finishedAt: null,
      mergedAt: null
    }
    this.db
      .prepare(
        `INSERT INTO tasks (id, created_at, text, project_id, agent, trigger_type, trigger_at,
                            status, scheduled_at)
         VALUES (@id, @createdAt, @text, @projectId, @agent, @triggerType, @triggerAt,
                 @status, @scheduledAt)`
      )
      .run({
        id: task.id,
        createdAt: task.createdAt,
        text: task.text,
        projectId: task.projectId,
        agent: task.agent,
        triggerType: task.triggerType,
        triggerAt: task.triggerAt,
        status: task.status,
        scheduledAt: task.scheduledAt
      })
    this.onChange?.(task)
    return task
  }

  get(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
    return row ? toTask(row) : null
  }

  list(): Task[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks ORDER BY created_at DESC')
      .all() as TaskRow[]
    return rows.map(toTask)
  }

  listByStatus(status: TaskStatus): Task[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at')
      .all(status) as TaskRow[]
    return rows.map(toTask)
  }

  /**
   * B1 追加:可编辑字段更新,仅 todo/scheduled 允许。
   * 只改字段不改状态——trigger 变化引发的 todo↔scheduled 升降级仍必须经 transition() 收口。
   */
  updateEditable(id: string, patch: EditableTaskPatch): Task {
    const current = this.get(id)
    if (!current) throw new Error(`task not found: ${id}`)
    if (current.status !== 'todo' && current.status !== 'scheduled') {
      throw new Error(`任务状态 ${current.status} 不可编辑`)
    }
    const next = {
      text: patch.text ?? current.text,
      projectId: patch.projectId ?? current.projectId,
      agent: patch.agent !== undefined ? patch.agent : current.agent,
      triggerType: patch.triggerType ?? current.triggerType,
      triggerAt: patch.triggerAt !== undefined ? patch.triggerAt : current.triggerAt
    }
    if (!next.text.trim()) throw new Error('任务文本不能为空')
    if (next.triggerType !== 'none' && !next.agent) {
      throw new Error('可执行任务(trigger ≠ none)必须指定 agent')
    }
    if (next.triggerType === 'at' && !next.triggerAt) {
      throw new Error('定时任务必须提供 triggerAt')
    }
    if (next.triggerType !== 'at') next.triggerAt = null
    this.db
      .prepare(
        `UPDATE tasks SET text = @text, project_id = @projectId, agent = @agent,
           trigger_type = @triggerType, trigger_at = @triggerAt WHERE id = @id`
      )
      .run({ id, ...next })
    const updated = this.get(id)
    if (!updated) throw new Error(`task disappeared during update: ${id}`)
    this.onChange?.(updated)
    return updated
  }

  /**
   * B3 追加:崩溃恢复专用的受限回填入口,不是通用更新方法。约束:
   * - 仅允许 failed/conflict/awaiting_merge 状态(恢复链路的落定态),其余状态一律抛错;
   * - 仅允许 worktree_path/branch/archive_dir 三个字段,且只能补写当前为 NULL 的字段,
   *   已有值不得覆盖(避免绕过 transition() 改写执行期事实);
   * - 状态变更仍必须走 transition(),本方法不碰 status。
   */
  attachRuntimePaths(id: string, patch: RuntimePathsPatch): Task {
    const current = this.get(id)
    if (!current) throw new Error(`task not found: ${id}`)
    if (!(RUNTIME_PATH_STATUSES as readonly TaskStatus[]).includes(current.status)) {
      throw new Error(`任务状态 ${current.status} 不允许回填运行期路径`)
    }
    const sets: string[] = []
    const params: Record<string, unknown> = { id }
    for (const [key, column] of Object.entries(RUNTIME_PATH_COLUMNS) as [
      keyof RuntimePathsPatch,
      string
    ][]) {
      if (patch[key] === undefined) continue
      if (current[key] !== null) {
        throw new Error(`任务 ${id} 的 ${key} 已有值,禁止覆盖回填`)
      }
      sets.push(`${column} = @${key}`)
      params[key] = patch[key]
    }
    if (sets.length === 0) return current
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = @id`).run(params)
    const updated = this.get(id)
    if (!updated) throw new Error(`task disappeared during attach: ${id}`)
    this.onChange?.(updated)
    return updated
  }

  transition(id: string, to: TaskStatus, patch: TransitionPatch = {}): Task {
    const current = this.get(id)
    if (!current) throw new Error(`task not found: ${id}`)
    assertTransition(current.status, to)

    const sets = ['status = @status']
    const params: Record<string, unknown> = { id, status: to }
    for (const [key, column] of Object.entries(PATCH_COLUMNS) as [keyof TransitionPatch, string][]) {
      if (patch[key] !== undefined) {
        sets.push(`${column} = @${key}`)
        params[key] = patch[key]
      }
    }
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = @id`).run(params)

    const updated = this.get(id)
    if (!updated) throw new Error(`task disappeared during transition: ${id}`)
    this.onChange?.(updated)
    return updated
  }
}
