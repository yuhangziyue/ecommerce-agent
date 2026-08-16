import type {
  IdempotencyRecord,
  IdempotencyStatus,
  IdempotencyStore,
} from '../auth/types.js';
import type { Database } from './types.js';

interface IdemRow {
  key: string;
  key_id: string;
  endpoint: string;
  request_hash: string;
  status: string;
  response_status: number | null;
  response_body: unknown;
  created_at: string | Date;
  expires_at: string | Date;
}

function ms(v: string | Date): number {
  return v instanceof Date ? v.getTime() : Date.parse(v);
}

function toRecord(row: IdemRow): IdempotencyRecord {
  return {
    key: row.key,
    keyId: row.key_id,
    endpoint: row.endpoint,
    requestHash: row.request_hash,
    status: row.status as IdempotencyStatus,
    responseStatus: row.response_status,
    responseBody: row.response_body,
    createdAt: ms(row.created_at),
    expiresAt: ms(row.expires_at),
  };
}

const COLUMNS =
  'key, key_id, endpoint, request_hash, status, response_status, response_body, created_at, expires_at';

export class PgIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: Database) {}

  /**
   * 尝试占位。
   *
   * **靠主键冲突而不是「先查再插」**：后者在并发下两个请求会同时查到空、
   * 同时认为自己是第一个 —— 而幂等键存在的全部意义就是应付并发重发。
   *
   * `ON CONFLICT DO UPDATE ... WHERE expires_at < now()` 让过期占位可以被抢走：
   * 上一个持有者的进程崩了，不该把这个 key 永久钉死。
   */
  async claim(input: {
    key: string;
    keyId: string;
    endpoint: string;
    requestHash: string;
    ttlMs: number;
    now: number;
  }): Promise<{ claimed: true } | { claimed: false; existing: IdempotencyRecord }> {
    const expiresAt = new Date(input.now + input.ttlMs).toISOString();
    const { rows } = await this.db.query<IdemRow>(
      `INSERT INTO idempotency_keys
         (key, key_id, endpoint, request_hash, status, expires_at)
       VALUES ($1, $2, $3, $4, 'in_progress', $5)
       ON CONFLICT (key, key_id) DO UPDATE
         SET request_hash = EXCLUDED.request_hash,
             endpoint     = EXCLUDED.endpoint,
             status       = 'in_progress',
             response_status = NULL,
             response_body   = NULL,
             created_at   = now(),
             expires_at   = EXCLUDED.expires_at
         WHERE idempotency_keys.expires_at < now()
       RETURNING ${COLUMNS}`,
      [input.key, input.keyId, input.endpoint, input.requestHash, expiresAt]
    );

    // 有返回行 = 插入成功或抢到了过期占位
    if (rows.length > 0) return { claimed: true };

    // 无返回行 = 冲突且未过期，把现有记录读出来交给调用方判断
    const { rows: existing } = await this.db.query<IdemRow>(
      `SELECT ${COLUMNS} FROM idempotency_keys WHERE key = $1 AND key_id = $2`,
      [input.key, input.keyId]
    );
    if (existing.length === 0) {
      // 极罕见：冲突行在两次查询之间被删了。当作可以重来
      return { claimed: true };
    }
    return { claimed: false, existing: toRecord(existing[0]) };
  }

  async complete(input: {
    key: string;
    keyId: string;
    responseStatus: number;
    responseBody: unknown;
  }): Promise<void> {
    await this.db.query(
      `UPDATE idempotency_keys
          SET status = 'completed', response_status = $3, response_body = $4::jsonb
        WHERE key = $1 AND key_id = $2`,
      [input.key, input.keyId, input.responseStatus, JSON.stringify(input.responseBody ?? null)]
    );
  }

  /**
   * 清理过期记录。
   *
   * 判据只有 `expires_at` 一个 —— **不看 status**：
   * 已完成的记录同样要在 TTL 之后消失，否则表只增不减。
   * 而"未过期的已完成记录"是要被重放的资产，绝不能删（由 `expires_at` 天然保护）。
   */
  async purgeExpired(now: number, limit: number): Promise<number> {
    const { rows } = await this.db.query<{ key: string }>(
      `DELETE FROM idempotency_keys
        WHERE (key, key_id) IN (
          SELECT key, key_id FROM idempotency_keys
           WHERE expires_at < $1
           LIMIT $2
        )
        RETURNING key`,
      [new Date(now).toISOString(), limit]
    );
    return rows.length;
  }

  /**
   * 释放占位（执行抛异常时用）。
   *
   * 直接删行而不是标记失败：调用方重发时应该**真的重新执行一次**，
   * 而不是拿到一个「上次失败了」的缓存 —— 失败往往是瞬时的。
   */
  async release(key: string, keyId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM idempotency_keys WHERE key = $1 AND key_id = $2 AND status = 'in_progress'`,
      [key, keyId]
    );
  }
}
