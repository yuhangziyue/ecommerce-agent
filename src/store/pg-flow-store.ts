import type { Database } from './types.js';
import type { FlowRecord, FlowState, FlowStore, FlowTransition } from '../flows/types.js';

function toFlow(r: Record<string, any>): FlowRecord {
  return {
    id: r.id,
    kind: r.kind,
    sessionId: r.session_id,
    subjectId: r.subject_id,
    state: r.state,
    data: r.data ?? {},
    createdAt: Math.round(Number(r.created_ms)),
    updatedAt: Math.round(Number(r.updated_ms)),
  };
}

const SELECT_FLOW = `
  SELECT id, kind, session_id, subject_id, state, data,
         EXTRACT(EPOCH FROM created_at) * 1000 AS created_ms,
         EXTRACT(EPOCH FROM updated_at) * 1000 AS updated_ms
    FROM business_flows`;

export class PgFlowStore implements FlowStore {
  constructor(private readonly db: Database) {}

  async create(input: {
    id: string;
    kind: string;
    sessionId: string;
    subjectId: string;
    state: FlowState;
    data?: Record<string, unknown>;
  }): Promise<FlowRecord> {
    const { rows } = await this.db.query<Record<string, any>>(
      `INSERT INTO business_flows (id, kind, session_id, subject_id, state, data)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, kind, session_id, subject_id, state, data,
                 EXTRACT(EPOCH FROM created_at) * 1000 AS created_ms,
                 EXTRACT(EPOCH FROM updated_at) * 1000 AS updated_ms`,
      [
        input.id,
        input.kind,
        input.sessionId,
        input.subjectId,
        input.state,
        JSON.stringify(input.data ?? {}),
      ]
    );
    return toFlow(rows[0]);
  }

  async get(id: string): Promise<FlowRecord | null> {
    const { rows } = await this.db.query<Record<string, any>>(
      `${SELECT_FLOW} WHERE id = $1`,
      [id]
    );
    return rows[0] ? toFlow(rows[0]) : null;
  }

  /**
   * 找某业务主键上未终结的流程。
   *
   * 终态列表由调用方（引擎）传入而不是写死在 SQL 里 —— 不同流程的终态不同，
   * 把它硬编码进 store 会让「加一条新流程」变成要同时改两个地方的活。
   */
  async findActiveBySubject(
    kind: string,
    subjectId: string,
    terminal: FlowState[]
  ): Promise<FlowRecord | null> {
    const { rows } = await this.db.query<Record<string, any>>(
      `${SELECT_FLOW}
        WHERE kind = $1 AND subject_id = $2
          AND NOT (state = ANY($3::text[]))
        ORDER BY seq DESC LIMIT 1`,
      [kind, subjectId, terminal]
    );
    return rows[0] ? toFlow(rows[0]) : null;
  }

  async listBySession(sessionId: string, limit = 20): Promise<FlowRecord[]> {
    const { rows } = await this.db.query<Record<string, any>>(
      `${SELECT_FLOW} WHERE session_id = $1 ORDER BY seq DESC LIMIT $2`,
      [sessionId, limit]
    );
    return rows.map(toFlow);
  }

  async update(
    id: string,
    state: FlowState,
    data: Record<string, unknown>
  ): Promise<FlowRecord> {
    const { rows } = await this.db.query<Record<string, any>>(
      `UPDATE business_flows
          SET state = $2, data = $3, updated_at = now()
        WHERE id = $1
       RETURNING id, kind, session_id, subject_id, state, data,
                 EXTRACT(EPOCH FROM created_at) * 1000 AS created_ms,
                 EXTRACT(EPOCH FROM updated_at) * 1000 AS updated_ms`,
      [id, state, JSON.stringify(data)]
    );
    if (!rows[0]) throw new Error(`流程 ${id} 不存在，无法更新`);
    return toFlow(rows[0]);
  }

  async appendTransition(t: FlowTransition): Promise<void> {
    await this.db.query(
      `INSERT INTO flow_transitions (flow_id, from_state, to_state, event, actor, note, created_at)
       VALUES ($1,$2,$3,$4,$5,$6, to_timestamp($7::double precision / 1000))`,
      [t.flowId, t.from, t.to, t.event, t.actor, t.note ?? null, t.at]
    );
  }

  async getTransitions(flowId: string): Promise<FlowTransition[]> {
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT flow_id, from_state, to_state, event, actor, note,
              EXTRACT(EPOCH FROM created_at) * 1000 AS at_ms
         FROM flow_transitions
        WHERE flow_id = $1
        ORDER BY seq`,
      [flowId]
    );
    return rows.map((r) => ({
      flowId: r.flow_id,
      from: r.from_state,
      to: r.to_state,
      event: r.event,
      actor: r.actor,
      note: r.note ?? undefined,
      at: Math.round(Number(r.at_ms)),
    }));
  }
}
