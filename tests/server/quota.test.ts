import { buildApp } from '../../src/server/app.js';
import { openTestDb, truncateAll, makeTestStores } from '../store/helpers.js';
import type { Database } from '../../src/store/types.js';
import type { Stores } from '../../src/store/index.js';
import type {
  AgentConfig,
  AgentTool,
  ChatProvider,
  ChatResponse,
} from '../../src/core/types.js';
import type { FastifyInstance } from 'fastify';

/** 每次调用烧掉固定 token，便于精确算账 */
class BurnProvider implements ChatProvider {
  calls = 0;
  constructor(private readonly perCall = 6000) {}

  async chat(system: string, _m: never, _t: AgentTool[]): Promise<ChatResponse> {
    if (system.includes('意图识别模块')) {
      return {
        content: '无法判断',
        toolUses: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end_turn',
      };
    }
    this.calls++;
    return {
      content: '好的，已为您处理',
      toolUses: [],
      usage: { inputTokens: this.perCall - 100, outputTokens: 100 },
      stopReason: 'end_turn',
    };
  }

  getModel(): string {
    return 'fake-model';
  }
}

const baseConfig: AgentConfig = {
  model: 'claude-sonnet-5',
  apiKey: 'test',
  maxTurns: 5,
  maxTokensPerSession: 20_000,
  systemPrompt: '你是客服助手',
  confirmHighRisk: false,
};

describe('会话配额 · v0.2 那个假的 maxTokensPerSession', () => {
  let db: Database;
  let stores: Stores;
  let app: FastifyInstance;
  let provider: BurnProvider;

  beforeAll(async () => {
    db = await openTestDb();
  });
  afterAll(async () => db.close());

  beforeEach(async () => {
    await truncateAll(db);
    stores = await makeTestStores(db);
    provider = new BurnProvider(6000);
    app = await buildApp({
      stores,
      config: baseConfig,
      provider,
      quotaLimits: { perSession: 20_000, perTenant: 0 },
    });
  });
  afterEach(async () => app.close());

  async function turn(message: string, sessionId?: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: sessionId
        ? { message, session_id: sessionId, tenant_id: 't_acme' }
        : { message, tenant_id: 't_acme' },
    });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }

  it('🔴 同一会话跨请求累计用量，超限被拦（v0.10 之前 5 轮 300k 一次都不拦）', async () => {
    // 每轮 6000，上限 20000 → 第 4 轮开始应被拦
    let sid: string | undefined;
    const outcomes: boolean[] = [];

    for (let i = 0; i < 5; i++) {
      const { body } = await turn(`第${i}轮`, sid);
      sid = body.session_id;
      outcomes.push((body.blocked?.length ?? 0) === 0);
    }

    // 前 4 轮放行（用量 0/6k/12k/18k 都还没到 20k），第 5 轮时已 24k → 拦
    expect(outcomes).toEqual([true, true, true, true, false]);

    // 关键：模型不再被无限次调用
    expect(provider.calls).toBe(4);
  });

  it('🔴 会话越限返回 200 + blocked 明细（可恢复，不是错误）', async () => {
    let sid: string | undefined;
    for (let i = 0; i < 4; i++) {
      const { body } = await turn(`第${i}轮`, sid);
      sid = body.session_id;
    }

    const { status, body } = await turn('再来一轮', sid);
    expect(status).toBe(200);
    expect(body.blocked[0].by).toBe('quota');
    expect(body.blocked[0].reason).toContain('新会话');
  });

  it('🔴 换个会话就能继续 —— 会话配额是长度管理，不是封禁', async () => {
    let sid: string | undefined;
    for (let i = 0; i < 5; i++) {
      const { body } = await turn(`第${i}轮`, sid);
      sid = body.session_id;
    }
    const callsBefore = provider.calls;

    const fresh = await turn('开个新会话');
    expect(fresh.body.blocked ?? []).toHaveLength(0);
    expect(provider.calls).toBe(callsBefore + 1);
  });

  it('🔴 用量活过 app 重建（进程重启不清零）', async () => {
    let sid: string | undefined;
    for (let i = 0; i < 4; i++) {
      const { body } = await turn(`第${i}轮`, sid);
      sid = body.session_id;
    }

    // 模拟重启：全新 app 实例，同一个库
    await app.close();
    app = await buildApp({
      stores,
      config: baseConfig,
      provider,
      quotaLimits: { perSession: 20_000, perTenant: 0 },
    });

    const { body } = await turn('重启后继续', sid);
    expect(body.blocked[0].by).toBe('quota');
  });
});

describe('租户配额 · 429', () => {
  let db: Database;
  let stores: Stores;
  let app: FastifyInstance;
  let provider: BurnProvider;

  beforeAll(async () => {
    db = await openTestDb();
  });
  afterAll(async () => db.close());

  beforeEach(async () => {
    await truncateAll(db);
    stores = await makeTestStores(db);
    provider = new BurnProvider(6000);
    app = await buildApp({
      stores,
      config: baseConfig,
      provider,
      quotaLimits: { perSession: 1_000_000, perTenant: 10_000 },
    });
  });
  afterEach(async () => app.close());

  it('🔴 租户配额用尽 → HTTP 429 + quota_exceeded（商业事件，不是对话问题）', async () => {
    // 烧掉 12000 > 10000
    for (let i = 0; i < 2; i++) {
      await app.inject({
        method: 'POST',
        url: '/v1/chat/sync',
        payload: { message: `第${i}轮`, tenant_id: 't_acme' },
      });
    }

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '还想问', tenant_id: 't_acme' },
    });

    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body).error.code).toBe('quota_exceeded');
  });

  it('🔴 租户越限时换新会话也没用（与会话配额的本质差别）', async () => {
    for (let i = 0; i < 2; i++) {
      await app.inject({
        method: 'POST',
        url: '/v1/chat/sync',
        payload: { message: `第${i}轮`, tenant_id: 't_acme' },
      });
    }
    const callsBefore = provider.calls;

    // 不带 session_id = 全新会话
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '新会话试试', tenant_id: 't_acme' },
    });

    expect(res.statusCode).toBe(429);
    expect(provider.calls).toBe(callsBefore); // 模型一次都没调
  });

  it('🔴 另一个租户不受影响（多租户隔离）', async () => {
    for (let i = 0; i < 2; i++) {
      await app.inject({
        method: 'POST',
        url: '/v1/chat/sync',
        payload: { message: `第${i}轮`, tenant_id: 't_acme' },
      });
    }

    const other = await app.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '我是别的租户', tenant_id: 't_globex' },
    });
    expect(other.statusCode).toBe(200);
  });

  it('SSE 路由同样在写响应头之前返回 429', async () => {
    for (let i = 0; i < 2; i++) {
      await app.inject({
        method: 'POST',
        url: '/v1/chat',
        payload: { message: `第${i}轮`, tenant_id: 't_acme' },
      });
    }

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      payload: { message: '再来', tenant_id: 't_acme' },
    });

    expect(res.statusCode).toBe(429);
    // 是 JSON 错误体而不是半个事件流
    expect(res.headers['content-type']).toContain('application/json');
  });
});

describe('GET /v1/tenants/:id/usage', () => {
  let db: Database;
  let stores: Stores;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await openTestDb();
  });
  afterAll(async () => db.close());

  beforeEach(async () => {
    await truncateAll(db);
    stores = await makeTestStores(db);
    app = await buildApp({
      stores,
      config: baseConfig,
      provider: new BurnProvider(6000),
      quotaLimits: { perSession: 1_000_000, perTenant: 100_000 },
    });
  });
  afterEach(async () => app.close());

  it('返回聚合用量与明细', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '你好', tenant_id: 't_acme' },
    });

    const res = await app.inject({ method: 'GET', url: '/v1/tenants/t_acme/usage' });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.tenant_id).toBe('t_acme');
    expect(body.summary.billable_tokens).toBeGreaterThan(0);
    expect(body.summary.call_count).toBeGreaterThan(0);
    expect(body.limits.per_tenant).toBe(100_000);
    expect(body.records[0].session_id).toBeTruthy();
    expect(body.records[0].pricing_resolved).toBe('exact');
  });

  it('🔴 未知租户返回全零而不是 404（404 会变成租户存在性探测接口）', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/tenants/t_nobody/usage' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).summary).toMatchObject({
      billable_tokens: 0,
      call_count: 0,
      cost_usd: 0,
    });
  });

  it('since 非法 → 400（不静默忽略）', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/tenants/t_acme/usage?since=不是数字',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('invalid_since');
  });

  it('🔴 无 tenant_id 的调用记到 anonymous，不丢账', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '匿名调用' },
    });

    const res = await app.inject({ method: 'GET', url: '/v1/tenants/anonymous/usage' });
    expect(JSON.parse(res.body).summary.call_count).toBeGreaterThan(0);
  });

  it('账本记的成本非零且按当时价格解析', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '你好', tenant_id: 't_acme' },
    });

    const body = JSON.parse(
      (await app.inject({ method: 'GET', url: '/v1/tenants/t_acme/usage' })).body
    );
    expect(body.summary.cost_usd).toBeGreaterThan(0);
    // 'exact' 表示命中了精确的价格窗口，不是回退到边界价或未知模型价 ——
    // 账目对不上时第一件事就是看这一列（v0.3 的 PriceWindow.resolved）
    expect(body.records[0].pricing_resolved).toBe('exact');
  });
});
