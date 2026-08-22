import type { Database } from 'better-sqlite3'
import type { AgentDetection, AgentId } from '@shared/types'

interface DetectionRow {
  agent_id: string
  ok: number
  version: string | null
  fail_reason: string | null
  checked_at: string
}

function toDetection(row: DetectionRow): AgentDetection {
  return {
    agentId: row.agent_id as AgentId,
    ok: row.ok === 1,
    version: row.version,
    failReason: row.fail_reason,
    checkedAt: row.checked_at
  }
}

/** agent_detections 表唯一写入口(spec §5.3 检测结果缓存) */
export class DetectionStore {
  constructor(private readonly db: Database) {}

  upsert(detection: AgentDetection): void {
    this.db
      .prepare(
        `INSERT INTO agent_detections (agent_id, ok, version, fail_reason, checked_at)
         VALUES (@agentId, @ok, @version, @failReason, @checkedAt)
         ON CONFLICT(agent_id) DO UPDATE SET
           ok = excluded.ok, version = excluded.version,
           fail_reason = excluded.fail_reason, checked_at = excluded.checked_at`
      )
      .run({
        agentId: detection.agentId,
        ok: detection.ok ? 1 : 0,
        version: detection.version,
        failReason: detection.failReason,
        checkedAt: detection.checkedAt
      })
  }

  get(agentId: AgentId): AgentDetection | null {
    const row = this.db.prepare('SELECT * FROM agent_detections WHERE agent_id = ?').get(agentId) as
      | DetectionRow
      | undefined
    return row ? toDetection(row) : null
  }

  list(): AgentDetection[] {
    const rows = this.db
      .prepare('SELECT * FROM agent_detections ORDER BY agent_id')
      .all() as DetectionRow[]
    return rows.map(toDetection)
  }
}
