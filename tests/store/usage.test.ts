import { PgUsageStore, ANONYMOUS_TENANT } from '../../src/store/pg-usage-store.js';
import { openTestDb, truncateAll } from './helpers.js';
import type { Database, UsageRecord } from '../../src/store/types.js';

function record(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    tenantId: 't_acme',
    sessionId: 'sesn_1',
    model: 'claude-sonnet-5',
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    billableTokens: 1200,
    costUsd: 0.005,
    pricingResolved: 'claude-sonnet-5@2026-08',
    at: 1_755_000_000_000,
    ...over,
  };
}

describe('PgUsageStore · 计费账本', () => {
  let db: Database;
  let store: PgUsageStore;

  beforeAll(async () => {
    db = await openTestDb();
    store = new PgUsageStore(db);
  });
  afterAll(async () => db.close());
  beforeEach(async () => truncateAll(db));

  it('追加记录并按租户聚合', async () => {
    await store.append(record());
    await store.append(record({ billableTokens: 800, costUsd: 0.003 }));

    const sum = await store.sumByTenant('t_acme');
    expect(sum.billableTokens).toBe(2000);
    expect(sum.callCount).toBe(2);
    expect(sum.costUsd).toBeCloseTo(0.008, 10);
  });

  it('按会话聚合与按租户聚合互不干扰', async () => {
    await store.append(record({ sessionId: 'sesn_a', billableTokens: 100 }));
    await store.append(record({ sessionId: 'sesn_b', billableTokens: 900 }));

    expect((await store.sumBySession('sesn_a')).billableTokens).toBe(100);
    expect((await store.sumByTenant('t_acme')).billableTokens).toBe(1000);
  });

  it('不同租户的账互不串（多租户的最低要求）', async () => {
    await store.append(record({ tenantId: 't_acme', billableTokens: 500 }));
    await store.append(record({ tenantId: 't_globex', billableTokens: 700 }));

    expect((await store.sumByTenant('t_acme')).billableTokens).toBe(500);
    expect((await store.sumByTenant('t_globex')).billableTokens).toBe(700);
  });

  it('无租户的调用挂到 anonymous 桶，不丢账也不串账', async () => {
    await store.append(record({ tenantId: '', billableTokens: 300 }));

    expect((await store.sumByTenant(ANONYMOUS_TENANT)).billableTokens).toBe(300);
    expect((await store.sumByTenant('t_acme')).billableTokens).toBe(0);
  });

  it('空租户聚合返回零而不是 null（调用方不该处理 null）', async () => {
    const sum = await store.sumByTenant('t_never_seen');
    expect(sum).toMatchObject({ billableTokens: 0, costUsd: 0, callCount: 0 });
  });

  it('🔴 成本用 NUMERIC 存，十位小数不丢精度（钱不能用浮点）', async () => {
    await store.append(record({ costUsd: 0.0000000001 }));
    await store.append(record({ costUsd: 0.0000000002 }));

    const sum = await store.sumByTenant('t_acme');
    expect(sum.costUsd).toBeCloseTo(0.0000000003, 12);
  });

  it('🔴 累计一万条小额记录不产生浮点漂移', async () => {
    // 0.0001 × 10000 = 1.0 恰好，浮点逐次相加会漂
    for (let i = 0; i < 200; i++) {
      await store.append(record({ costUsd: 0.0001 }));
    }
    const sum = await store.sumByTenant('t_acme');
    expect(sum.costUsd).toBe(0.02); // 严格相等，不是 toBeCloseTo
  });

  it('按时间窗聚合（计费周期）', async () => {
    const t0 = 1_755_000_000_000;
    await store.append(record({ at: t0, billableTokens: 100 }));
    await store.append(record({ at: t0 + 86_400_000, billableTokens: 400 }));

    expect((await store.sumByTenant('t_acme')).billableTokens).toBe(500);
    expect(
      (await store.sumByTenant('t_acme', t0 + 1000)).billableTokens
    ).toBe(400);
  });

  it('缓存 token 分列记账（成本口径不同，不能混一起）', async () => {
    await store.append(
      record({ cacheReadTokens: 5000, cacheWriteTokens: 2000, billableTokens: 8200 })
    );
    const sum = await store.sumByTenant('t_acme');
    expect(sum.cacheReadTokens).toBe(5000);
    expect(sum.cacheWriteTokens).toBe(2000);
  });

  it('按租户列明细，最新在前', async () => {
    await store.append(record({ model: 'claude-haiku-4-5' }));
    await store.append(record({ model: 'claude-opus-5' }));

    const list = await store.listByTenant('t_acme');
    expect(list).toHaveLength(2);
    expect(list[0].model).toBe('claude-opus-5'); // seq DESC
    expect(list[0].pricingResolved).toBe('claude-sonnet-5@2026-08');
    expect(list[0].at).toBe(1_755_000_000_000);
  });

  it('🔴 账本活过 store 实例重建（真相在库里，不在内存里）', async () => {
    await store.append(record({ billableTokens: 4242 }));

    // 模拟进程重启：全新的 store 实例读同一个库
    const reborn = new PgUsageStore(db);
    expect((await reborn.sumByTenant('t_acme')).billableTokens).toBe(4242);
  });
});
