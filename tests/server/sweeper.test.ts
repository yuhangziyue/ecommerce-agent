import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { openTestDb, truncateAll } from '../store/helpers.js';
import { PgIdempotencyStore } from '../../src/store/pg-idempotency-store.js';
import { startSweeper } from '../../src/server/sweeper.js';
import type { Database } from '../../src/store/types.js';

/**
 * 过期幂等记录的清理（v1.2 · D-6）。
 *
 * v1.1 给记录加了 `expires_at`，但**没有任何东西读它** —— 表只增不减。
 * 这类"字段建好了却没人用"和 v0.14 那个十三个版本没人读的 `ResponseScorer`
 * 是同一个物种，只是后果不同：这个是慢性的表膨胀。
 */

let db: Database;
let store: PgIdempotencyStore;

beforeAll(async () => {
  db = await openTestDb();
  store = new PgIdempotencyStore(db);
});
afterAll(async () => db.close());
beforeEach(async () => truncateAll(db));

const NOW = 1_800_000_000_000;

async function seed(key: string, ttlMs: number, createdAt = NOW): Promise<void> {
  await store.claim({
    key,
    keyId: 'key_a',
    endpoint: 'POST /v1/chat/sync',
    requestHash: 'h',
    ttlMs,
    now: createdAt,
  });
}

const count = async (): Promise<number> =>
  Number(
    (await db.query<{ n: string }>('SELECT count(*) AS n FROM idempotency_keys')).rows[0].n
  );

describe('purgeExpired', () => {
  it('🔴 P25 只删过期的，未过期的一条不动', async () => {
    await seed('expired', 1_000, NOW - 10_000); // 早已过期
    await seed('alive', 600_000, NOW); // 还早

    const deleted = await store.purgeExpired(NOW, 100);

    expect(deleted).toBe(1);
    expect(await count()).toBe(1);
    // 剩下的必须是没过期那条
    const { rows } = await db.query<{ key: string }>('SELECT key FROM idempotency_keys');
    expect(rows[0].key).toBe('alive');
  });

  it('🔴 P26 已完成但未过期的记录不能被删（它们是要被重放的资产）', async () => {
    await seed('done', 600_000, NOW);
    await store.complete({
      key: 'done',
      keyId: 'key_a',
      responseStatus: 200,
      responseBody: { reply: '你好' },
    });

    await store.purgeExpired(NOW, 100);

    // 删了的话，调用方重发就会**真的再执行一次** —— 幂等保证当场失效
    const again = await store.claim({
      key: 'done',
      keyId: 'key_a',
      endpoint: 'POST /v1/chat/sync',
      requestHash: 'h',
      ttlMs: 600_000,
      now: NOW,
    });
    expect(again.claimed).toBe(false);
  });

  it('已完成且已过期的记录会被删（否则表只增不减）', async () => {
    await seed('old-done', 1_000, NOW - 10_000);
    await store.complete({
      key: 'old-done',
      keyId: 'key_a',
      responseStatus: 200,
      responseBody: {},
    });

    expect(await store.purgeExpired(NOW, 100)).toBe(1);
  });

  it('🔴 P27 单次删除有上限（一次 DELETE 扫全表会长时间持锁）', async () => {
    for (let i = 0; i < 10; i++) await seed(`k${i}`, 1_000, NOW - 10_000);

    expect(await store.purgeExpired(NOW, 3)).toBe(3);
    expect(await count()).toBe(7);
  });

  it('没有过期记录时返回 0，不报错', async () => {
    await seed('alive', 600_000, NOW);
    expect(await store.purgeExpired(NOW, 100)).toBe(0);
  });
});

describe('Sweeper', () => {
  it('runOnce 删除并回调条数', async () => {
    await seed('a', 1_000, NOW - 10_000);
    await seed('b', 1_000, NOW - 10_000);

    const swept: number[] = [];
    const sweeper = startSweeper({
      store,
      intervalMs: 0, // 不起定时器，只手工跑
      now: () => NOW,
      onSwept: (n) => swept.push(n),
    });

    expect(await sweeper.runOnce()).toBe(2);
    expect(swept).toEqual([2]);
    expect(sweeper.running).toBe(false);
  });

  it('🔴 P28 定时器 unref，不阻止进程退出', async () => {
    const sweeper = startSweeper({ store, intervalMs: 60_000, now: () => NOW });
    expect(sweeper.running).toBe(true);
    // 一个后台维护任务不该让 SIGTERM 之后的进程挂着不走。
    // 断言方式：进程里没有活跃 handle 阻塞退出 —— unref 过的定时器不计入
    sweeper.stop();
    expect(sweeper.running).toBe(false);
  });

  it('🔴 清理失败不抛出（它是维护动作，不是业务动作）', async () => {
    const broken = {
      ...store,
      purgeExpired: async () => {
        throw new Error('库连不上');
      },
    } as unknown as PgIdempotencyStore;

    const sweeper = startSweeper({ store: broken, intervalMs: 0 });
    await expect(sweeper.runOnce()).resolves.toBe(0);
  });

  it('intervalMs <= 0 时不启动定时器', () => {
    const sweeper = startSweeper({ store, intervalMs: 0 });
    expect(sweeper.running).toBe(false);
  });
});
