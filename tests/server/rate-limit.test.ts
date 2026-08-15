import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import { InProcessRateLimiter, NoOpRateLimiter } from '../../src/server/rate-limit.js';
import { openTestDb, truncateAll, makeTestStores } from '../store/helpers.js';
import { seedKey, type TestKey } from './helpers.js';
import type { Database } from '../../src/store/types.js';
import type { Stores } from '../../src/store/index.js';
import type { AgentConfig, AgentTool, ChatProvider, ChatResponse } from '../../src/core/types.js';

const usage = { inputTokens: 10, outputTokens: 5 };

class FakeProvider implements ChatProvider {
  async chat(system: string, _m: never, _t: AgentTool[]): Promise<ChatResponse> {
    if (system.includes('意图识别模块')) {
      return { content: '无法判断', toolUses: [], usage, stopReason: 'end_turn' };
    }
    return { content: '好的', toolUses: [], usage, stopReason: 'end_turn' };
  }
  getModel(): string {
    return 'fake-model';
  }
}

const config: AgentConfig = {
  model: 'fake-model',
  maxTurns: 5,
  maxTokensPerSession: 100_000,
  systemPrompt: '测试助手',
  confirmHighRisk: true,
};

describe('令牌桶（注入时钟）', () => {
  it('突发容量内连续放行，超出即拒', async () => {
    let t = 0;
    const limiter = new InProcessRateLimiter({ rps: 10, burst: 3, now: () => t });

    expect((await limiter.consume('k')).allowed).toBe(true);
    expect((await limiter.consume('k')).allowed).toBe(true);
    expect((await limiter.consume('k')).allowed).toBe(true);
    expect((await limiter.consume('k')).allowed).toBe(false);
  });

  it('🔴 拒绝时给出可用的 Retry-After（不能是 0）', async () => {
    let t = 0;
    const limiter = new InProcessRateLimiter({ rps: 2, burst: 1, now: () => t });

    await limiter.consume('k');
    const denied = await limiter.consume('k');

    expect(denied.allowed).toBe(false);
    // rps=2 → 一个令牌需要 500ms。告诉调用方「立刻重试」等于让他继续撞墙
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(500);
  });

  it('时间流逝后按速率补充令牌', async () => {
    let t = 0;
    const limiter = new InProcessRateLimiter({ rps: 10, burst: 2, now: () => t });

    await limiter.consume('k');
    await limiter.consume('k');
    expect((await limiter.consume('k')).allowed).toBe(false);

    t = 100; // 100ms × 10rps = 1 个令牌
    expect((await limiter.consume('k')).allowed).toBe(true);
  });

  it('🔴 补充有上限，不会攒出一个巨大的突发', async () => {
    let t = 0;
    const limiter = new InProcessRateLimiter({ rps: 10, burst: 2, now: () => t });

    t = 3_600_000; // 空闲一小时
    // 攒够 36000 个令牌？不行 —— 上限就是 burst，否则一次爆发能打穿下游
    expect((await limiter.consume('k')).allowed).toBe(true);
    expect((await limiter.consume('k')).allowed).toBe(true);
    expect((await limiter.consume('k')).allowed).toBe(false);
  });

  it('🔴 不同 key 各自一个桶', async () => {
    let t = 0;
    const limiter = new InProcessRateLimiter({ rps: 1, burst: 1, now: () => t });

    expect((await limiter.consume('a')).allowed).toBe(true);
    expect((await limiter.consume('a')).allowed).toBe(false);
    expect((await limiter.consume('b')).allowed).toBe(true);
  });

  it('NoOp 永远放行（限流关闭时的显式形态）', async () => {
    const limiter = new NoOpRateLimiter();
    for (let i = 0; i < 100; i++) {
      expect((await limiter.consume('k')).allowed).toBe(true);
    }
  });
});

describe('限流接进 HTTP（P17–P19）', () => {
  let db: Database;
  let stores: Stores;
  let app: FastifyInstance;
  let clock = 0;
  let acme: TestKey;
  let globex: TestKey;

  beforeAll(async () => {
    db = await openTestDb();
    stores = await makeTestStores(db);
    app = await buildApp({
      stores,
      config,
      provider: new FakeProvider(),
      rateLimiter: new InProcessRateLimiter({ rps: 4, burst: 2, now: () => clock }),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
    clock = 0;
    acme = await seedKey(stores, { tenantId: 't_acme' });
    globex = await seedKey(stores, { tenantId: 't_globex' });
  });

  it('🔴 P17 超出突发容量 → 429 + Retry-After', async () => {
    const get = () =>
      app.inject({ method: 'GET', url: '/v1/agents', headers: acme.headers });

    expect((await get()).statusCode).toBe(200);
    expect((await get()).statusCode).toBe(200);

    const denied = await get();
    expect(denied.statusCode).toBe(429);
    expect(denied.json().error.code).toBe('rate_limited');
    expect(Number(denied.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('🔴 P18 限的是凭证不是 IP —— 两个 key 同源互不影响', async () => {
    // inject 下所有请求的来源完全相同。按 IP 限流的话，
    // 网关后面的所有租户会共享一个桶：一个租户跑量就把所有人打死
    await app.inject({ method: 'GET', url: '/v1/agents', headers: acme.headers });
    await app.inject({ method: 'GET', url: '/v1/agents', headers: acme.headers });
    const acmeDenied = await app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: acme.headers,
    });
    expect(acmeDenied.statusCode).toBe(429);

    const other = await app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: globex.headers,
    });
    expect(other.statusCode).toBe(200);
  });

  it('P19 时间推进后恢复放行', async () => {
    const get = () =>
      app.inject({ method: 'GET', url: '/v1/agents', headers: acme.headers });

    await get();
    await get();
    expect((await get()).statusCode).toBe(429);

    clock = 1000; // rps=4 → 补满 burst
    expect((await get()).statusCode).toBe(200);
  });

  it('🔴 探针不被限流 —— 否则高负载时实例会被误判为不健康', async () => {
    // 那正是雪崩的开始：限流 → 探针挂 → 摘节点 → 剩下的更挤 → 全挂
    for (let i = 0; i < 10; i++) {
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    }
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(200);
  });

  it('限流发生在业务之前 —— 429 时不新建会话', async () => {
    const post = () =>
      app.inject({
        method: 'POST',
        url: '/v1/chat/sync',
        payload: { message: '你好' },
        headers: acme.headers,
      });

    await post();
    await post();
    const denied = await post();
    expect(denied.statusCode).toBe(429);

    const { rows } = await db.query<{ n: string }>('SELECT count(*) AS n FROM sessions');
    expect(Number(rows[0].n)).toBe(2);
  });
});
