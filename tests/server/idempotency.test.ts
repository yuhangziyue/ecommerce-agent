import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import { openTestDb, truncateAll, makeTestStores } from '../store/helpers.js';
import { seedKey, clientFor, type TestKey, type TestClient } from './helpers.js';
import type { Database } from '../../src/store/types.js';
import type { Stores } from '../../src/store/index.js';
import type { AgentConfig, AgentTool, ChatProvider, ChatResponse } from '../../src/core/types.js';

/**
 * 幂等键（P20–P24）。
 *
 * 这一层挡的是最贵的一种重复：**客户端超时重发 → 退款被执行两次**。
 * v0.3（退款库级幂等）、v0.12（确认单一次性消费）、v1.0（高风险工具不重试）
 * 三版都在防重复执行，但入口敞着的时候，重发就是一个全新的请求、
 * 全新的 tool_use_id、全新的确认单 —— 那三道防线一道都不生效。
 */

const usage = { inputTokens: 10, outputTokens: 5 };

class FakeProvider implements ChatProvider {
  calls = 0;
  /** 设为 true 时抛错，用来验证失败不落幂等记录 */
  shouldThrow = false;

  async chat(system: string, _m: never, _t: AgentTool[]): Promise<ChatResponse> {
    if (system.includes('意图识别模块')) {
      return { content: '无法判断', toolUses: [], usage, stopReason: 'end_turn' };
    }
    this.calls++;
    if (this.shouldThrow) throw new Error('模型服务抖了一下');
    return {
      content: `第 ${this.calls} 次真实执行`,
      toolUses: [],
      usage,
      stopReason: 'end_turn',
    };
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

describe('幂等键', () => {
  let db: Database;
  let stores: Stores;
  let app: FastifyInstance;
  let provider: FakeProvider;
  let acme: TestKey;
  let globex: TestKey;
  let client: TestClient;
  let otherClient: TestClient;

  beforeAll(async () => {
    db = await openTestDb();
    stores = await makeTestStores(db);
    provider = new FakeProvider();
    app = await buildApp({ stores, config, provider });
    client = clientFor(app, () => acme);
    otherClient = clientFor(app, () => globex);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
    provider.calls = 0;
    provider.shouldThrow = false;
    acme = await seedKey(stores, { tenantId: 't_acme' });
    globex = await seedKey(stores, { tenantId: 't_globex' });
  });

  const payload = { message: '给订单 ORD-1 退款' };

  it('🔴 P20 同 key 同体重放 → 同一个响应，模型只被调用一次', async () => {
    const first = await client.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload,
      headers: { 'idempotency-key': 'idem-1' },
    });
    const second = await client.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload,
      headers: { 'idempotency-key': 'idem-1' },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    // 这是全组最关键的断言：重发没有产生第二次执行
    expect(provider.calls).toBe(1);
    expect(second.json().session_id).toBe(first.json().session_id);
    expect(second.json().reply).toBe(first.json().reply);
  });

  it('🔴 重放响应带 Idempotent-Replay 头 —— 调用方要能分辨', async () => {
    const first = await client.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload,
      headers: { 'idempotency-key': 'idem-2' },
    });
    const second = await client.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload,
      headers: { 'idempotency-key': 'idem-2' },
    });

    expect(first.headers['idempotent-replay']).toBe('false');
    // 不告诉他的话，重放会被当成一次新的成功执行
    expect(second.headers['idempotent-replay']).toBe('true');
  });

  it('🔴 P21 同 key 不同体 → 409，而不是返回旧响应', async () => {
    await client.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload,
      headers: { 'idempotency-key': 'idem-3' },
    });

    const conflict = await client.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '换个完全不同的问题' },
      headers: { 'idempotency-key': 'idem-3' },
    });

    // 返回旧响应的话，调用方会以为自己的新请求生效了 —— 而实际上什么都没发生
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('idempotency_key_reused');
    expect(provider.calls).toBe(1);
  });

  it('P22 不同 key → 各执行一次', async () => {
    await client.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload,
      headers: { 'idempotency-key': 'a' },
    });
    await client.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload,
      headers: { 'idempotency-key': 'b' },
    });
    expect(provider.calls).toBe(2);
  });

  it('不带幂等键 → 普通请求，不强制（老调用方不用改）', async () => {
    await client.inject({ method: 'POST', url: '/v1/chat/sync', payload });
    await client.inject({ method: 'POST', url: '/v1/chat/sync', payload });
    expect(provider.calls).toBe(2);
  });

  it('🔴 P24 幂等记录按 principal 隔离 —— 两个租户用同一个 key 互不命中', async () => {
    const a = await client.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload,
      headers: { 'idempotency-key': '同一个-uuid' },
    });
    const b = await otherClient.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload,
      headers: { 'idempotency-key': '同一个-uuid' },
    });

    expect(b.statusCode).toBe(200);
    expect(b.headers['idempotent-replay']).toBe('false');
    // 命中别人的记录 = 拿到别人的会话号和回复，这是跨租户数据泄露
    expect(b.json().session_id).not.toBe(a.json().session_id);
    expect(provider.calls).toBe(2);
  });

  it('🔴 P23 确认单决策带同 key 重放 → 返回原响应而不是 409 already_decided', async () => {
    const chat = await client.inject({ method: 'POST', url: '/v1/chat/sync', payload });
    await stores.confirmations.create({
      id: 'cfm_idem',
      sessionId: chat.json().session_id,
      toolName: 'refund_apply',
      toolInput: { order_id: 'ORD-1', reason: '质量问题' },
      summary: '为订单 ORD-1 申请退款',
    });

    const decide = () =>
      client.inject({
        method: 'POST',
        url: '/v1/confirmations/cfm_idem',
        payload: { approved: true },
        headers: { 'idempotency-key': 'decide-1' },
      });

    const first = await decide();
    const second = await decide();

    expect(first.statusCode).toBe(200);
    // 没有幂等键的话，第二次会撞上 v0.12 的「已决策过」409 ——
    // 而调用方只是网络超时重发，他并没有做错任何事
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
  });

  it('🔴 P24d 模型挂了 → 502 upstream_error，而不是 200 + 一句错误正文', async () => {
    provider.shouldThrow = true;
    const first = await client.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload,
      headers: { 'idempotency-key': 'idem-fail' },
    });

    // AgentLoop 会把 `LLM调用失败: xxx` 当成正常回复返回 —— 回 200 的话，
    // 接入方会把这句话当成客服的回答展示给客户（v0.12「谎称已处理」的同一物种）
    expect(first.statusCode).toBe(502);
    expect(first.json().error.code).toBe('upstream_error');

    // 🔴 P24c：失败往往是瞬时的。把失败固化下来，
    // 调用方在整个 TTL（24 小时）内拿同一个键重试都只会拿到那句错误
    provider.shouldThrow = false;
    const retry = await client.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload,
      headers: { 'idempotency-key': 'idem-fail' },
    });
    expect(retry.statusCode).toBe(200);
  });

  it('🔴 4xx 结果会被重放（那是调用方的问题，重试也是同样的结果）', async () => {
    const send = () =>
      client.inject({
        method: 'POST',
        url: '/v1/chat/sync',
        payload: { message: '你好', tenant_id: 't_globex' }, // 403
        headers: { 'idempotency-key': 'idem-403' },
      });

    const first = await send();
    const second = await send();
    expect(first.statusCode).toBe(403);
    expect(second.statusCode).toBe(403);
    expect(second.headers['idempotent-replay']).toBe('true');
  });
});

describe('幂等键 · SSE（P24b）', () => {
  let db: Database;
  let stores: Stores;
  let app: FastifyInstance;
  let provider: FakeProvider;
  let acme: TestKey;
  let client: TestClient;

  beforeAll(async () => {
    db = await openTestDb();
    stores = await makeTestStores(db);
    provider = new FakeProvider();
    app = await buildApp({ stores, config, provider });
    client = clientFor(app, () => acme);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
    provider.calls = 0;
    acme = await seedKey(stores, { tenantId: 't_acme' });
  });

  it('🔴 P24b 重复请求 → 409 already_completed + session_id，模型不被二次调用', async () => {
    const first = await client.inject({
      method: 'POST',
      url: '/v1/chat',
      payload: { message: '你好' },
      headers: { 'idempotency-key': 'sse-1' },
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toContain('text/event-stream');

    const second = await client.inject({
      method: 'POST',
      url: '/v1/chat',
      payload: { message: '你好' },
      headers: { 'idempotency-key': 'sse-1' },
    });

    // **刻意不重放流**：流里有 confirmation_required 这类当时才成立的事件，
    // 重放会让客户端弹出一个早已被决策过的确认框。指路比伪造一条流诚实
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('already_completed');
    expect(second.json().error.session_id).toBe(first.headers['x-session-id']);
    expect(provider.calls).toBe(1);
  });

  it('SSE 不带幂等键时行为完全不变', async () => {
    const res = await client.inject({
      method: 'POST',
      url: '/v1/chat',
      payload: { message: '你好' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('event: done');
  });
});
