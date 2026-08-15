import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { openTestDb, truncateAll } from './helpers.js';
import { PgApiKeyStore } from '../../src/store/pg-api-key-store.js';
import { PgIdempotencyStore } from '../../src/store/pg-idempotency-store.js';
import { hashApiKey } from '../../src/auth/api-key.js';
import type { Database } from '../../src/store/types.js';

let db: Database;
let keys: PgApiKeyStore;
let idem: PgIdempotencyStore;

beforeAll(async () => {
  db = await openTestDb();
  keys = new PgApiKeyStore(db, 'test');
  idem = new PgIdempotencyStore(db);
});
beforeEach(async () => truncateAll(db));
afterAll(async () => db.close());

describe('ApiKeyStore', () => {
  it('签发后能用明文的哈希查回来', async () => {
    const { record, plaintext } = await keys.issue({
      tenantId: 't_acme',
      scopes: ['chat', 'read'],
      label: '官网客服',
    });

    const found = await keys.findByHash(hashApiKey(plaintext));
    expect(found?.keyId).toBe(record.keyId);
    expect(found?.tenantId).toBe('t_acme');
    expect(found?.scopes).toEqual(['chat', 'read']);
    expect(found?.label).toBe('官网客服');
  });

  it('🔴 库里存的是哈希，全表任何一列都查不到明文', async () => {
    const { plaintext } = await keys.issue({ tenantId: 't1', scopes: ['chat'] });

    const { rows } = await db.query<Record<string, unknown>>('SELECT * FROM api_keys');
    const dumped = JSON.stringify(rows);

    // 库被拖走 ≠ 凭证泄露。这是密钥存储的最低要求
    expect(dumped).not.toContain(plaintext);
    expect(dumped).toContain(hashApiKey(plaintext));
  });

  it('落库的 prefix 只是辨认用，不足以还原明文', async () => {
    const { record, plaintext } = await keys.issue({ tenantId: 't1', scopes: ['chat'] });
    expect(plaintext.startsWith(record.prefix)).toBe(true);
    expect(record.prefix.length).toBeLessThan(plaintext.length - 30);
  });

  it('错误的明文查不到任何记录', async () => {
    await keys.issue({ tenantId: 't1', scopes: ['chat'] });
    expect(await keys.findByHash(hashApiKey('ak_test_不存在'))).toBeNull();
  });

  it('吊销后记录仍在，但带上了 revokedAt', async () => {
    const { record, plaintext } = await keys.issue({ tenantId: 't1', scopes: ['chat'] });

    expect(await keys.revoke(record.keyId)).toBe(true);

    // 记录**不删**：谁在什么时候用过这把钥匙是审计资产
    const found = await keys.findByHash(hashApiKey(plaintext));
    expect(found).not.toBeNull();
    expect(found!.revokedAt).toBeGreaterThan(0);
  });

  it('🔴 重复吊销返回 false，且不改写吊销时间', async () => {
    const { record } = await keys.issue({ tenantId: 't1', scopes: ['chat'] });
    expect(await keys.revoke(record.keyId)).toBe(true);

    const first = (await keys.listByTenant('t1'))[0].revokedAt;
    expect(await keys.revoke(record.keyId)).toBe(false);

    // 「什么时候被吊销的」是审计问题，第二次操作不该改写答案
    expect((await keys.listByTenant('t1'))[0].revokedAt).toBe(first);
  });

  it('吊销不存在的 key 返回 false', async () => {
    expect(await keys.revoke('key_不存在')).toBe(false);
  });

  it('🔴 listByTenant 只返回本租户的钥匙', async () => {
    await keys.issue({ tenantId: 't_a', scopes: ['chat'] });
    await keys.issue({ tenantId: 't_a', scopes: ['read'] });
    await keys.issue({ tenantId: 't_b', scopes: ['chat'] });

    expect(await keys.listByTenant('t_a')).toHaveLength(2);
    expect((await keys.listByTenant('t_b'))[0].tenantId).toBe('t_b');
  });

  it('🔴 库里被手工塞进未知 scope 时过滤掉，而不是照单接受', async () => {
    const { record, plaintext } = await keys.issue({ tenantId: 't1', scopes: ['chat'] });
    await db.query(`UPDATE api_keys SET scopes = $2::jsonb WHERE key_id = $1`, [
      record.keyId,
      JSON.stringify(['chat', 'root', 'admin']),
    ]);

    // 'root' 不是系统认识的权限。既然不认识，就不该让它进到 Principal 里
    // 变成一个「不生效但也不报错」的东西
    const found = await keys.findByHash(hashApiKey(plaintext));
    expect(found!.scopes).toEqual(['chat', 'admin']);
  });

  it('touch 记录最近使用时间', async () => {
    const { record, plaintext } = await keys.issue({ tenantId: 't1', scopes: ['chat'] });
    expect((await keys.findByHash(hashApiKey(plaintext)))!.lastUsedAt).toBeNull();

    await keys.touch(record.keyId, 1_700_000_000_000);
    expect((await keys.findByHash(hashApiKey(plaintext)))!.lastUsedAt).toBe(
      1_700_000_000_000
    );
  });
});

describe('IdempotencyStore', () => {
  const base = {
    key: 'idem-1',
    keyId: 'key_a',
    endpoint: 'POST /v1/chat/sync',
    requestHash: 'hash-1',
    ttlMs: 60_000,
  };

  it('第一次占位成功', async () => {
    const r = await idem.claim({ ...base, now: Date.now() });
    expect(r.claimed).toBe(true);
  });

  it('🔴 第二次占位失败，并带回已有记录', async () => {
    await idem.claim({ ...base, now: Date.now() });
    const r = await idem.claim({ ...base, now: Date.now() });

    expect(r.claimed).toBe(false);
    if (r.claimed) throw new Error('unreachable');
    expect(r.existing.status).toBe('in_progress');
    expect(r.existing.requestHash).toBe('hash-1');
  });

  it('🔴 同一个 key 换个 keyId 是另一条记录 —— 不能跨租户命中', async () => {
    await idem.claim({ ...base, now: Date.now() });
    // 两个租户各自生成了同一个 UUID，A 的重放绝不能拿到 B 的响应
    const other = await idem.claim({ ...base, keyId: 'key_b', now: Date.now() });
    expect(other.claimed).toBe(true);
  });

  it('complete 之后能读到响应，状态转 completed', async () => {
    await idem.claim({ ...base, now: Date.now() });
    await idem.complete({
      key: base.key,
      keyId: base.keyId,
      responseStatus: 200,
      responseBody: { session_id: 's1', reply: '你好' },
    });

    const r = await idem.claim({ ...base, now: Date.now() });
    if (r.claimed) throw new Error('应当冲突');
    expect(r.existing.status).toBe('completed');
    expect(r.existing.responseStatus).toBe(200);
    expect(r.existing.responseBody).toEqual({ session_id: 's1', reply: '你好' });
  });

  it('🔴 占位过期后可以被重新抢占 —— 进程崩溃不该把 key 永久钉死', async () => {
    const past = Date.now() - 120_000;
    await idem.claim({ ...base, ttlMs: 1_000, now: past }); // 早已过期

    const r = await idem.claim({ ...base, now: Date.now() });
    expect(r.claimed).toBe(true);
  });

  it('🔴 未过期的占位不会被抢占', async () => {
    await idem.claim({ ...base, ttlMs: 600_000, now: Date.now() });
    const r = await idem.claim({ ...base, now: Date.now() });
    expect(r.claimed).toBe(false);
  });

  it('release 之后可以重新占位（失败往往是瞬时的，该让人重试）', async () => {
    await idem.claim({ ...base, now: Date.now() });
    await idem.release(base.key, base.keyId);

    const r = await idem.claim({ ...base, now: Date.now() });
    expect(r.claimed).toBe(true);
  });

  it('🔴 release 不会删掉已完成的记录', async () => {
    await idem.claim({ ...base, now: Date.now() });
    await idem.complete({
      key: base.key,
      keyId: base.keyId,
      responseStatus: 200,
      responseBody: { ok: true },
    });
    await idem.release(base.key, base.keyId);

    // 已完成的响应是要被重放的资产，不能被一个迟到的 release 抹掉
    const r = await idem.claim({ ...base, now: Date.now() });
    expect(r.claimed).toBe(false);
  });
});
