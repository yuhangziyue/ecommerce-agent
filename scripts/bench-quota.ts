/**
 * 配额检查的代价与并发超发上限。
 *
 * 回答两个问题：
 *   1. 把配额检查放进每个请求的关键路径，慢多少？（DB 直读 vs Redis 计数器）
 *   2. 「先检查后扣减」到底能超发多少？（v0.11 SPEC 设计③ 里承诺要给的数字）
 *
 * 用法：npm run bench:quota
 * 有 6380 上的测试 Redis 则同时测 Redis 计数器，否则只测 DB。
 *
 * ⚠️ 这不是测试，不进 npm test —— 墙钟波动不该让测试变红。
 */
import { PGliteDatabase } from '../src/store/database.js';
import { runMigrations } from '../src/store/migrations.js';
import { PgUsageStore } from '../src/store/pg-usage-store.js';
import {
  DbQuotaCounter,
  QuotaService,
  createQuotaCounter,
  type QuotaCounter,
} from '../src/billing/quota.js';
import type { UsageRecord } from '../src/store/types.js';

const TEST_REDIS_URL = 'redis://127.0.0.1:6380';
const ROUNDS = 200;
const LIMIT = 1_000_000;

function record(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    tenantId: 't_bench',
    sessionId: 'sesn_bench',
    model: 'claude-sonnet-5',
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    billableTokens: 1200,
    costUsd: 0.005,
    at: 1_755_000_000_000,
    ...over,
  };
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

async function measureCheck(counter: QuotaCounter): Promise<number[]> {
  const svc = new QuotaService(counter, { perSession: LIMIT, perTenant: LIMIT });
  const samples: number[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    const t0 = process.hrtime.bigint();
    await svc.check({ tenantId: 't_bench', sessionId: 'sesn_bench' });
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return samples;
}

async function main(): Promise<void> {
  const db = await PGliteDatabase.open();
  await runMigrations(db);
  const usage = new PgUsageStore(db);

  // 铺一些账本数据，让聚合查询不是在空表上跑
  console.log('铺设账本数据…');
  for (let i = 0; i < 500; i++) {
    await usage.append(record({ sessionId: `sesn_${i % 20}` }));
  }

  console.log('='.repeat(70));
  console.log('  配额检查延迟基准 [模拟：PGlite 进程内 PG]');
  console.log('='.repeat(70));
  console.log(`  账本规模: 500 条 ｜ 采样: ${ROUNDS} 次（取中位数）\n`);

  const dbCounter = new DbQuotaCounter(usage);
  const dbSamples = await measureCheck(dbCounter);

  const redisCounter = await createQuotaCounter(usage, TEST_REDIS_URL);
  const hasRedis = redisCounter.kind === 'redis';
  const redisSamples = hasRedis ? await measureCheck(redisCounter) : [];

  console.log('计数器              中位延迟      p95');
  console.log('-'.repeat(70));
  const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)];
  console.log(
    `DB 直读             ${median(dbSamples).toFixed(3).padStart(8)}ms  ${p95(dbSamples).toFixed(3).padStart(8)}ms`
  );
  if (hasRedis) {
    console.log(
      `Redis 计数器        ${median(redisSamples).toFixed(3).padStart(8)}ms  ${p95(redisSamples).toFixed(3).padStart(8)}ms`
    );
    const speedup = median(dbSamples) / Math.max(median(redisSamples), 0.0001);
    console.log(
      `\n  Redis 快 ${speedup.toFixed(1)}× —— 但真实生产里 DB 是跨网络的，差距会更大。\n` +
        '  这也是为什么计数器是**账本的缓存**而不是账本本身：\n' +
        '  配额检查在每个请求的关键路径上，账本聚合不该出现在那里。\n'
    );
  } else {
    console.log('\n  ⚠️  6380 上没有测试 Redis，跳过 Redis 计数器测量。\n');
  }

  // ── 超发测量 ──
  console.log('='.repeat(70));
  console.log('  并发超发上限（「先检查后扣减」的已知代价）');
  console.log('='.repeat(70));

  const PER_TURN = 6000;
  for (const concurrency of [1, 2, 4, 8, 16]) {
    // 每次重来：额度刚好剩 1 个 token
    await db.exec('TRUNCATE usage_records RESTART IDENTITY;');
    const sessionId = `sesn_burst_${concurrency}`;
    await usage.append(
      record({ sessionId, billableTokens: LIMIT - 1, tenantId: 't_burst' })
    );

    const svc = new QuotaService(new DbQuotaCounter(usage), {
      perSession: LIMIT,
      perTenant: 0,
    });
    const verdicts = await Promise.all(
      Array.from({ length: concurrency }, () =>
        svc.check({ tenantId: 't_burst', sessionId })
      )
    );
    const passed = verdicts.filter((v) => v.allowed).length;
    console.log(
      `  并发 ${String(concurrency).padStart(2)}：${passed} 个请求同时通过检查 ` +
        `→ 最大超发 ${(passed * PER_TURN).toLocaleString()} tokens`
    );
  }

  console.log(
    '\n  超发上限 = 并发数 × 单轮最大用量，**有界且可预测**。\n' +
      '  对 token 计费来说这个量级可接受：租户配额通常以百万计，\n' +
      '  16 并发的极端情况也就多送十万级，且下一个请求必然被拦。\n' +
      '  要做到精确需要预留-提交（reserve-then-commit），代价是处理预留泄漏\n' +
      '  （请求崩溃后额度悬空）—— 那个复杂度换这点精度不值。\n'
  );

  await redisCounter.close();
  await db.close();
}

main().catch((err) => {
  console.error('基准运行失败:', err);
  process.exit(1);
});
