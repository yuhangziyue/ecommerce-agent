import {
  DbQuotaCounter,
  QuotaService,
  createQuotaCounter,
} from '../../src/billing/quota.js';
import { PgUsageStore } from '../../src/store/pg-usage-store.js';
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
    at: Date.now(),
    ...over,
  };
}

describe('QuotaService · 两级配额', () => {
  let db: Database;
  let usage: PgUsageStore;

  beforeAll(async () => {
    db = await openTestDb();
    usage = new PgUsageStore(db);
  });
  afterAll(async () => db.close());
  beforeEach(async () => truncateAll(db));

  const service = (perSession: number, perTenant: number) =>
    new QuotaService(new DbQuotaCounter(usage), { perSession, perTenant });

  it('未超限时放行', async () => {
    const v = await service(10_000, 100_000).check({
      tenantId: 't_acme',
      sessionId: 'sesn_1',
    });
    expect(v.allowed).toBe(true);
  });

  it('🔴 会话级越限 → 可恢复，提示换会话', async () => {
    await usage.append(record({ billableTokens: 10_000 }));

    const v = await service(10_000, 1_000_000).check({
      tenantId: 't_acme',
      sessionId: 'sesn_1',
    });
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.scope).toBe('session');
    expect(v.allowed === false && v.reason).toContain('新会话');
  });

  it('🔴 租户级越限 → 不可恢复，明说开新会话没用', async () => {
    await usage.append(record({ billableTokens: 100_000 }));

    const v = await service(1_000_000, 100_000).check({
      tenantId: 't_acme',
      sessionId: 'sesn_new',
    });
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.scope).toBe('tenant');
    expect(v.allowed === false && v.reason).toContain('无法恢复');
  });

  it('🔴 两级同时越限时报租户 —— 先告诉用户那个换会话也解决不了的', async () => {
    await usage.append(record({ sessionId: 'sesn_1', billableTokens: 100_000 }));

    const v = await service(1000, 1000).check({
      tenantId: 't_acme',
      sessionId: 'sesn_1',
    });
    expect(v.allowed === false && v.scope).toBe('tenant');
  });

  it('🔴 换会话能绕过会话配额，但绕不过租户配额（配额分级的意义）', async () => {
    await usage.append(record({ sessionId: 'sesn_1', billableTokens: 10_000 }));
    const svc = service(10_000, 100_000);

    // 老会话满了
    expect((await svc.check({ tenantId: 't_acme', sessionId: 'sesn_1' })).allowed).toBe(
      false
    );
    // 换新会话可以继续 —— 租户额度还有
    expect((await svc.check({ tenantId: 't_acme', sessionId: 'sesn_2' })).allowed).toBe(
      true
    );
  });

  it('接近上限时放行但带预警', async () => {
    await usage.append(record({ billableTokens: 8500 }));

    const v = await service(10_000, 1_000_000).check({
      tenantId: 't_acme',
      sessionId: 'sesn_1',
    });
    expect(v.allowed).toBe(true);
    expect(v.allowed === true && v.warning).toContain('85.0%');
  });

  it('无租户 id 时只做会话级配额（匿名调用不该无处可挂）', async () => {
    await usage.append(record({ sessionId: 'sesn_1', billableTokens: 10_000 }));

    const v = await service(10_000, 100).check({ tenantId: null, sessionId: 'sesn_1' });
    expect(v.allowed === false && v.scope).toBe('session'); // 不是 tenant
  });

  it('限额为 0 表示不限（关掉某一级）', async () => {
    await usage.append(record({ billableTokens: 999_999 }));

    const v = await service(0, 0).check({ tenantId: 't_acme', sessionId: 'sesn_1' });
    expect(v.allowed).toBe(true);
  });

  it('🔴 配额跨 store 实例仍然有效（进程重启不清零）', async () => {
    await usage.append(record({ billableTokens: 10_000 }));

    // 全新的 store + counter + service，模拟重启
    const reborn = new QuotaService(new DbQuotaCounter(new PgUsageStore(db)), {
      perSession: 10_000,
      perTenant: 1_000_000,
    });
    expect((await reborn.check({ tenantId: 't_acme', sessionId: 'sesn_1' })).allowed).toBe(
      false
    );
  });

  it('计费周期起点之前的用量不计入租户配额', async () => {
    const now = Date.now();
    await usage.append(record({ billableTokens: 100_000, at: now - 86_400_000 * 40 }));

    const thisMonth = new QuotaService(new DbQuotaCounter(usage, now - 86_400_000 * 30), {
      perSession: 1_000_000,
      perTenant: 100_000,
    });
    expect((await thisMonth.check({ tenantId: 't_acme', sessionId: 's' })).allowed).toBe(
      true
    );
  });
});

describe('QuotaCounter · 降级与并发', () => {
  let db: Database;
  let usage: PgUsageStore;

  beforeAll(async () => {
    db = await openTestDb();
    usage = new PgUsageStore(db);
  });
  afterAll(async () => db.close());
  beforeEach(async () => truncateAll(db));

  it('🔴 无 Redis URL → 降级为 DB 计数器，行为正确只是慢', async () => {
    const counter = await createQuotaCounter(usage, undefined);
    expect(counter.kind).toBe('db');

    await usage.append(record({ billableTokens: 777 }));
    expect(await counter.get('tenant', 't_acme')).toBe(777);
  });

  it('🔴 Redis 连不上 → 降级而不是抛错（配额不该让服务起不来）', async () => {
    const counter = await createQuotaCounter(usage, 'redis://127.0.0.1:1'); // 无人监听
    expect(counter.kind).toBe('db');
    await counter.close();
  });

  it('🔴 DB 计数器下并发落账不丢更新（库的原子性兜底）', async () => {
    await Promise.all(
      Array.from({ length: 10 }, () =>
        usage.append(record({ sessionId: 'sesn_race', billableTokens: 1000 }))
      )
    );

    const counter = new DbQuotaCounter(usage);
    expect(await counter.get('session', 'sesn_race')).toBe(10_000);
  });

  it('🔴 测量超发上限：N 个并发同时通过检查（先检查后扣减的已知代价）', async () => {
    const svc = new QuotaService(new DbQuotaCounter(usage), {
      perSession: 10_000,
      perTenant: 1_000_000,
    });
    // 已用 9999，只剩 1 个 token 的额度
    await usage.append(record({ sessionId: 'sesn_burst', billableTokens: 9_999 }));

    const CONCURRENCY = 8;
    const verdicts = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        svc.check({ tenantId: 't_acme', sessionId: 'sesn_burst' })
      )
    );

    // 全部放行 —— 这就是超发：8 个请求都看到「还剩额度」
    const passed = verdicts.filter((v) => v.allowed).length;
    expect(passed).toBe(CONCURRENCY);

    // 但下一轮检查一定拦住 —— 超发是有界的，不是无限的
    await usage.append(record({ sessionId: 'sesn_burst', billableTokens: 1 }));
    expect((await svc.check({ tenantId: 't_acme', sessionId: 'sesn_burst' })).allowed).toBe(
      false
    );
  });
});

// 测试用 Redis 跑在 6380（本机 6379 需要认证且密码未知）
const TEST_REDIS_URL = 'redis://127.0.0.1:6380';

describe('RedisQuotaCounter · 原子扣减（需要 6380 上的测试 Redis）', () => {
  let db: Database;
  let usage: PgUsageStore;
  let counter: Awaited<ReturnType<typeof createQuotaCounter>>;
  let available = false;

  beforeAll(async () => {
    db = await openTestDb();
    usage = new PgUsageStore(db);
    counter = await createQuotaCounter(usage, TEST_REDIS_URL);
    available = counter.kind === 'redis';
  });

  afterAll(async () => {
    await counter?.close();
    await db.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
    if (available) {
      const { default: Redis } = await import('ioredis');
      const r = new Redis(TEST_REDIS_URL);
      const keys = await r.keys('quota:*');
      if (keys.length) await r.del(...keys);
      await r.quit();
    }
  });

  it('🔴 并发累加不丢更新（INCRBY 原子，这正是选它的原因）', async () => {
    if (!available) return;

    const N = 50;
    await Promise.all(
      Array.from({ length: N }, () => counter.add('session', 'sesn_atomic', 100))
    );

    // 50 × 100 = 5000，一次不漏。非原子的「读-加-写」在这里必然丢更新
    expect(await counter.get('session', 'sesn_atomic')).toBe(N * 100);
  });

  it('🔴 冷启动回库重建计数（键丢了不等于用量清零）', async () => {
    if (!available) return;

    // 账本里有 3000，但 Redis 里没有对应的键
    await usage.append(record({ sessionId: 'sesn_cold', billableTokens: 3000 }));

    expect(await counter.get('session', 'sesn_cold')).toBe(3000);
  });

  it('🔴 回库重建后继续累加，不从 0 起算（否则重启即免单）', async () => {
    if (!available) return;

    await usage.append(record({ sessionId: 'sesn_warm', billableTokens: 3000 }));
    const after = await counter.add('session', 'sesn_warm', 500);
    expect(after).toBe(3500);
  });

  it('租户与会话是独立的计数维度', async () => {
    if (!available) return;

    await counter.add('session', 'x', 100);
    await counter.add('tenant', 'x', 700);

    expect(await counter.get('session', 'x')).toBe(100);
    expect(await counter.get('tenant', 'x')).toBe(700);
  });

  it('🔴 Redis 计数器下的配额检查与 DB 计数器结论一致', async () => {
    if (!available) return;

    await usage.append(record({ sessionId: 'sesn_cmp', billableTokens: 10_000 }));
    const limits = { perSession: 10_000, perTenant: 1_000_000 };

    const viaRedis = await new QuotaService(counter, limits).check({
      tenantId: 't_acme',
      sessionId: 'sesn_cmp',
    });
    const viaDb = await new QuotaService(new DbQuotaCounter(usage), limits).check({
      tenantId: 't_acme',
      sessionId: 'sesn_cmp',
    });

    expect(viaRedis.allowed).toBe(false);
    expect(viaRedis.allowed).toBe(viaDb.allowed);
  });
});
