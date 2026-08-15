import { generateApiKey, hashApiKey } from '../auth/api-key.js';
import { isScope, type ApiKeyRecord, type ApiKeyStore, type Scope } from '../auth/types.js';
import type { Database } from './types.js';

interface KeyRow {
  key_id: string;
  tenant_id: string;
  scopes: unknown;
  label: string | null;
  prefix: string;
  revoked_at: string | Date | null;
  last_used_at: string | Date | null;
  created_at: string | Date;
}

function ts(v: string | Date | null): number | null {
  if (v === null) return null;
  return v instanceof Date ? v.getTime() : Date.parse(v);
}

function toRecord(row: KeyRow): ApiKeyRecord {
  return {
    keyId: row.key_id,
    tenantId: row.tenant_id,
    // 库里的 scopes 是 JSONB，**过一遍白名单**：手工改库塞进一个 'root'
    // 不该变成一个系统不认识但也不拒绝的权限
    scopes: (Array.isArray(row.scopes) ? row.scopes : []).filter(
      (s): s is Scope => typeof s === 'string' && isScope(s)
    ),
    label: row.label,
    prefix: row.prefix,
    revokedAt: ts(row.revoked_at),
    createdAt: ts(row.created_at) ?? 0,
    lastUsedAt: ts(row.last_used_at),
  };
}

const COLUMNS =
  'key_id, tenant_id, scopes, label, prefix, revoked_at, last_used_at, created_at';

function newKeyId(): string {
  return `key_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export class PgApiKeyStore implements ApiKeyStore {
  constructor(
    private readonly db: Database,
    /** 签发时写进明文的环境标记。测试库签出的钥匙不该长得像生产的 */
    private readonly env: 'live' | 'test' = 'live'
  ) {}

  async findByHash(hash: string): Promise<ApiKeyRecord | null> {
    const { rows } = await this.db.query<KeyRow>(
      `SELECT ${COLUMNS} FROM api_keys WHERE key_hash = $1`,
      [hash]
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * 签发。**明文只在这个方法的返回值里出现一次**，
   * 之后系统里任何地方都拿不到它 —— 包括我们自己。
   */
  async issue(input: {
    tenantId: string;
    scopes: Scope[];
    label?: string;
  }): Promise<{ record: ApiKeyRecord; plaintext: string }> {
    const generated = generateApiKey(this.env);
    const keyId = newKeyId();

    const { rows } = await this.db.query<KeyRow>(
      `INSERT INTO api_keys (key_id, key_hash, tenant_id, scopes, label, prefix)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       RETURNING ${COLUMNS}`,
      [
        keyId,
        generated.hash,
        input.tenantId,
        JSON.stringify(input.scopes),
        input.label ?? null,
        generated.prefix,
      ]
    );

    return { record: toRecord(rows[0]), plaintext: generated.plaintext };
  }

  /**
   * 吊销。
   *
   * `WHERE revoked_at IS NULL` 让重复吊销返回 false 而不是把时间戳往后推 ——
   * 「这把钥匙是什么时候被吊销的」是审计问题，第二次操作不该改写答案。
   */
  async revoke(keyId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ key_id: string }>(
      `UPDATE api_keys SET revoked_at = now()
        WHERE key_id = $1 AND revoked_at IS NULL
        RETURNING key_id`,
      [keyId]
    );
    return rows.length > 0;
  }

  async listByTenant(tenantId: string): Promise<ApiKeyRecord[]> {
    const { rows } = await this.db.query<KeyRow>(
      `SELECT ${COLUMNS} FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId]
    );
    return rows.map(toRecord);
  }

  /** 审计信息，写失败不该影响请求 —— 调用方是 fire-and-forget 的 */
  async touch(keyId: string, at: number): Promise<void> {
    await this.db.query(
      'UPDATE api_keys SET last_used_at = $2 WHERE key_id = $1',
      [keyId, new Date(at).toISOString()]
    );
  }
}

export { hashApiKey };
