import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import { openTestDb, truncateAll, makeTestStores } from '../store/helpers.js';
import { seedKey, clientFor, type TestKey, type TestClient } from './helpers.js';
import type { Database } from '../../src/store/types.js';
import type { Stores } from '../../src/store/index.js';
import type { AgentConfig, AgentTool, ChatProvider, ChatResponse } from '../../src/core/types.js';

const usage = { inputTokens: 10, outputTokens: 5 };

class FakeProvider implements ChatProvider {
  calls = 0;
  async chat(system: string, _m: never, _t: AgentTool[]): Promise<ChatResponse> {
    if (system.includes('意图识别模块')) {
      return { content: '无法判断', toolUses: [], usage, stopReason: 'end_turn' };
    }
    this.calls++;
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

describe('认证（v1.1）', () => {
  let db: Database;
  let stores: Stores;
  let app: FastifyInstance;
  let provider: FakeProvider;
  let key: TestKey;
  let client: TestClient;

  beforeAll(async () => {
    db = await openTestDb();
    stores = await makeTestStores(db);
    provider = new FakeProvider();
    app = await buildApp({ stores, config, provider });
    client = clientFor(app, () => key);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
    provider.calls = 0;
    key = await seedKey(stores, { tenantId: 't_acme' });
  });

  // ============ P1–P4：拒绝的四种形态返回同一个错误体 ============

  it('🔴 P1 没带 Authorization → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '你好' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
    // 未认证的请求**一次模型调用都不该发生**
    expect(provider.calls).toBe(0);
  });

  it('P1b 401 必须带 WWW-Authenticate（RFC 7235）', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/agents' });
    expect(res.headers['www-authenticate']).toContain('Bearer');
  });

  it('P2 格式错误的头 → 401', async () => {
    for (const authorization of ['abc', 'Basic dXNlcjpwdw==', 'Bearer', 'Bearer   ']) {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/agents',
        headers: { authorization },
      });
      expect(res.statusCode, authorization).toBe(401);
    }
  });

  it('P3 不存在的 key → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: { authorization: 'Bearer ak_test_根本不存在' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('🔴 P4 已吊销的 key → 401，且与"不存在"返回完全相同的错误体', async () => {
    await stores.apiKeys.revoke(key.keyId);

    const revoked = await app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: key.headers,
    });
    const nonexistent = await app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: { authorization: 'Bearer ak_test_不存在' },
    });

    expect(revoked.statusCode).toBe(401);
    // 报得不一样，这就成了一个「这把钥匙曾经存在过吗」的探测接口
    expect(revoked.json()).toEqual(nonexistent.json());
  });

  it('有效 key → 放行，并绑定到它的租户', async () => {
    const res = await client.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '你好' },
    });

    expect(res.statusCode).toBe(200);
    const session = await client.inject({
      method: 'GET',
      url: `/v1/sessions/${res.json().session_id}`,
    });
    expect(session.json().tenant_id).toBe('t_acme');
  });

  // ============ P5：明文不落库 ============

  it('🔴 P5 库里存的是哈希 —— 全表任何一列都查不到明文', async () => {
    const { rows } = await db.query<Record<string, unknown>>('SELECT * FROM api_keys');
    expect(JSON.stringify(rows)).not.toContain(key.plaintext);
  });

  // ============ P6：免认证路径 ============

  it('P6 /healthz 与 /metrics 无凭证可访问', async () => {
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(200);
  });

  it('🔴 /healthz 暴露认证与限流状态 —— 运维必须看得见它们的档位', async () => {
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).json();
    expect(body.auth).toBe('enabled');
    // 「限流在多实例下失准」这件事，运维不知道就等于没有限流
    expect(['redis', 'in-process', 'off']).toContain(body.rate_limit);
  });

  // ============ P16b/P16c：scope ============

  it('🔴 P16b 缺少 scope → 403 insufficient_scope（不是 404）', async () => {
    const readOnly = await seedKey(stores, { tenantId: 't_acme', scopes: ['read'] });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '你好' },
      headers: readOnly.headers,
    });

    // 403 而不是 404：他拥有这个租户，只是权限不够 —— 不是在探测别人的资源
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('insufficient_scope');
    expect(provider.calls).toBe(0);
  });

  it('🔴 P16c admin 不隐含 chat —— 只做审计的管理端不该能发起对话', async () => {
    const adminOnly = await seedKey(stores, { tenantId: 't_acme', scopes: ['admin'] });

    const chat = await app.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '你好' },
      headers: adminOnly.headers,
    });
    expect(chat.statusCode).toBe(403);

    // 但 read 类操作同样要显式的 read scope
    const read = await app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: adminOnly.headers,
    });
    expect(read.statusCode).toBe(403);
  });

  it('写操作需要 write scope', async () => {
    const noWrite = await seedKey(stores, { tenantId: 't_acme', scopes: ['chat', 'read'] });
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/tenants/t_acme/config',
      payload: { quota_limits: { perSession: 100 } },
      headers: noWrite.headers,
    });
    expect(res.statusCode).toBe(403);
  });

  it('最近使用时间被记录（审计）', async () => {
    await client.inject({ method: 'GET', url: '/v1/agents' });
    // touch 是 fire-and-forget，给它一个事件循环 tick
    await new Promise((r) => setTimeout(r, 50));

    const list = await stores.apiKeys.listByTenant('t_acme');
    expect(list.find((k) => k.keyId === key.keyId)!.lastUsedAt).toBeGreaterThan(0);
  });
});

describe('AGENT_AUTH_DISABLED（P7）', () => {
  let db: Database;
  let stores: Stores;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await openTestDb();
    stores = await makeTestStores(db);
    app = await buildApp({
      stores,
      config,
      provider: new FakeProvider(),
      auth: { disabled: true },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('🔴 P7 关闭认证后无凭证也能调用，租户落到 anonymous', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '你好' },
    });

    expect(res.statusCode).toBe(200);

    const session = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${res.json().session_id}`,
    });
    expect(session.json().tenant_id).toBe('anonymous');
  });

  it('🔴 /healthz 把「认证已关闭」明说出来', async () => {
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).json();
    // 一个悄悄关着认证的实例，比一个明显没做认证的服务危险得多
    expect(body.auth).toBe('disabled');
  });
});
