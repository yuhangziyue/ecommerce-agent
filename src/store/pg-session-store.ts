import type { SessionEntry } from '../core/types.js';
import type {
  CreateSessionInput,
  Database,
  SessionRecord,
  SessionStore,
} from './types.js';

interface SessionRow {
  id: string;
  user_id: string | null;
  tenant_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  metadata: Record<string, unknown>;
}

interface EntryRow {
  seq: string | number;
  type: string;
  data: unknown;
}

function toMillis(value: string | Date): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function toRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
    metadata: row.metadata ?? {},
  };
}

function newSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const SESSION_COLUMNS = 'id, user_id, tenant_id, created_at, updated_at, metadata';

export class PgSessionStore implements SessionStore {
  constructor(private readonly db: Database) {}

  async create(input: CreateSessionInput = {}): Promise<SessionRecord> {
    const id = input.id ?? newSessionId();
    const { rows } = await this.db.query<SessionRow>(
      `INSERT INTO sessions (id, user_id, tenant_id, metadata)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING ${SESSION_COLUMNS}`,
      [
        id,
        input.userId ?? null,
        input.tenantId ?? null,
        JSON.stringify(input.metadata ?? {}),
      ]
    );
    return toRecord(rows[0]);
  }

  async get(id: string): Promise<SessionRecord | null> {
    const { rows } = await this.db.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = $1`,
      [id]
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listByUser(userId: string, limit = 50): Promise<SessionRecord[]> {
    const { rows } = await this.db.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM sessions
       WHERE user_id = $1
       ORDER BY seq DESC
       LIMIT $2`,
      [userId, limit]
    );
    return rows.map(toRecord);
  }

  async listByTenant(tenantId: string, limit = 50): Promise<SessionRecord[]> {
    const { rows } = await this.db.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM sessions
       WHERE tenant_id = $1
       ORDER BY seq DESC
       LIMIT $2`,
      [tenantId, limit]
    );
    return rows.map(toRecord);
  }

  /**
   * 独占本会话的一轮（v1.2）。
   *
   * **compare-and-set 而不是「先查再写」**：后者在并发下两个请求会同时查到
   * 「没锁」、同时认为自己拿到了 —— 而这个锁存在的全部意义就是应付并发。
   *
   * `WHERE turn_locked_until IS NULL OR turn_locked_until < $2` 让过期锁可被抢走：
   * 上一个持有者的进程崩了，不该把这条会话永久钉死。
   */
  async acquireTurnLock(sessionId: string, ttlMs: number, now: number): Promise<boolean> {
    const { rows } = await this.db.query<{ id: string }>(
      `UPDATE sessions
          SET turn_locked_until = $3
        WHERE id = $1
          AND (turn_locked_until IS NULL OR turn_locked_until < $2)
        RETURNING id`,
      [sessionId, new Date(now).toISOString(), new Date(now + ttlMs).toISOString()]
    );
    return rows.length > 0;
  }

  async releaseTurnLock(sessionId: string): Promise<void> {
    await this.db.query('UPDATE sessions SET turn_locked_until = NULL WHERE id = $1', [
      sessionId,
    ]);
  }

  async appendEntry(sessionId: string, entry: SessionEntry): Promise<void> {
    // 单条 INSERT 就是原子的 —— 不会像 appendFileSync 那样交错出半行。
    // 顺便刷新 updated_at，便于「最近活跃会话」这类查询。
    await this.db.query(
      `INSERT INTO session_entries (session_id, type, data) VALUES ($1, $2, $3::jsonb)`,
      [sessionId, entry.type, JSON.stringify(entry.data)]
    );
    await this.db.query(`UPDATE sessions SET updated_at = now() WHERE id = $1`, [
      sessionId,
    ]);
  }

  /**
   * 按 `seq` 排序，**不按 created_at** —— 并发写入下时间戳可能完全相同，
   * 而 v0.3 的投影逻辑对顺序敏感（tool_result 必须跟在产生它的 assistant 之后）。
   *
   * 返回的 `SessionEntry.timestamp` 填的是 `seq`：调用方只把它当「单调递增的顺序标记」用，
   * 真实时间在 `created_at` 列上（当前业务代码不需要，需要时再加字段）。
   */
  async getEntries(sessionId: string): Promise<SessionEntry[]> {
    const { rows } = await this.db.query<EntryRow>(
      `SELECT seq, type, data FROM session_entries
       WHERE session_id = $1
       ORDER BY seq ASC`,
      [sessionId]
    );
    return rows.map((row) => ({
      type: row.type as SessionEntry['type'],
      data: row.data as SessionEntry['data'],
      timestamp: Number(row.seq),
    }));
  }
}
