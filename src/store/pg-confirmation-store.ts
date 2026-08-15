import type { Database } from './types.js';
import type { ConfirmationRecord, ConfirmationStore } from '../flows/types.js';

function toRecord(r: Record<string, any>): ConfirmationRecord {
  return {
    id: r.id,
    sessionId: r.session_id,
    toolName: r.tool_name,
    toolInput: r.tool_input ?? {},
    summary: r.summary,
    status: r.status,
    decidedBy: r.decided_by ?? undefined,
    createdAt: Math.round(Number(r.created_ms)),
    decidedAt: r.decided_ms == null ? undefined : Math.round(Number(r.decided_ms)),
    consumedAt: r.consumed_ms == null ? undefined : Math.round(Number(r.consumed_ms)),
  };
}

const SELECT = `
  SELECT id, session_id, tool_name, tool_input, summary, status, decided_by,
         EXTRACT(EPOCH FROM created_at)  * 1000 AS created_ms,
         EXTRACT(EPOCH FROM decided_at)  * 1000 AS decided_ms,
         EXTRACT(EPOCH FROM consumed_at) * 1000 AS consumed_ms
    FROM confirmations`;

export class PgConfirmationStore implements ConfirmationStore {
  constructor(private readonly db: Database) {}

  async create(input: {
    id: string;
    sessionId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    summary: string;
  }): Promise<ConfirmationRecord> {
    const { rows } = await this.db.query<Record<string, any>>(
      `INSERT INTO confirmations (id, session_id, tool_name, tool_input, summary)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, session_id, tool_name, tool_input, summary, status, decided_by,
                 EXTRACT(EPOCH FROM created_at)  * 1000 AS created_ms,
                 EXTRACT(EPOCH FROM decided_at)  * 1000 AS decided_ms,
                 EXTRACT(EPOCH FROM consumed_at) * 1000 AS consumed_ms`,
      [
        input.id,
        input.sessionId,
        input.toolName,
        JSON.stringify(input.toolInput),
        input.summary,
      ]
    );
    return toRecord(rows[0]);
  }

  async get(id: string): Promise<ConfirmationRecord | null> {
    const { rows } = await this.db.query<Record<string, any>>(`${SELECT} WHERE id = $1`, [
      id,
    ]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * 找同一会话中针对相同工具与入参的未决确认单。
   *
   * 没有这个查询的话，模型每轮重试都会生成一张新的待确认单 ——
   * 客户会看到「请确认」「请确认」「请确认」而每张都指向同一件事。
   * 入参用 JSONB 相等比较（`@>` 双向包含），键顺序不影响判定。
   */
  async findPending(
    sessionId: string,
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<ConfirmationRecord | null> {
    const { rows } = await this.db.query<Record<string, any>>(
      `${SELECT}
        WHERE session_id = $1 AND tool_name = $2 AND status = 'pending'
          AND tool_input @> $3::jsonb AND tool_input <@ $3::jsonb
        ORDER BY seq DESC LIMIT 1`,
      [sessionId, toolName, JSON.stringify(toolInput)]
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * 决策。`WHERE status = 'pending'` 是并发下的防线 ——
   * 两个人同时点批准/拒绝时，只有一个生效，另一个拿到 null。
   */
  async decide(
    id: string,
    approved: boolean,
    decidedBy: string
  ): Promise<ConfirmationRecord | null> {
    const { rows } = await this.db.query<Record<string, any>>(
      `UPDATE confirmations
          SET status = $2, decided_by = $3, decided_at = now()
        WHERE id = $1 AND status = 'pending'
       RETURNING id, session_id, tool_name, tool_input, summary, status, decided_by,
                 EXTRACT(EPOCH FROM created_at)  * 1000 AS created_ms,
                 EXTRACT(EPOCH FROM decided_at)  * 1000 AS decided_ms,
                 EXTRACT(EPOCH FROM consumed_at) * 1000 AS consumed_ms`,
      [id, approved ? 'approved' : 'rejected', decidedBy]
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * 消费。`WHERE status = 'approved'` 让确认单**一次性** ——
   * 少了这个条件，一张批准过的确认单能被重放成任意多次退款。
   */
  async consume(id: string): Promise<ConfirmationRecord | null> {
    const { rows } = await this.db.query<Record<string, any>>(
      `UPDATE confirmations
          SET status = 'consumed', consumed_at = now()
        WHERE id = $1 AND status = 'approved'
       RETURNING id, session_id, tool_name, tool_input, summary, status, decided_by,
                 EXTRACT(EPOCH FROM created_at)  * 1000 AS created_ms,
                 EXTRACT(EPOCH FROM decided_at)  * 1000 AS decided_ms,
                 EXTRACT(EPOCH FROM consumed_at) * 1000 AS consumed_ms`,
      [id]
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listBySession(sessionId: string, limit = 20): Promise<ConfirmationRecord[]> {
    const { rows } = await this.db.query<Record<string, any>>(
      `${SELECT} WHERE session_id = $1 ORDER BY seq DESC LIMIT $2`,
      [sessionId, limit]
    );
    return rows.map(toRecord);
  }
}
