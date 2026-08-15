import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import { openTestDb, truncateAll, makeTestStores } from '../store/helpers.js';
import { seedKeyOn, type TestKey } from './helpers.js';
import { PgSessionStore } from '../../src/store/pg-session-store.js';
import { PgRefundStore } from '../../src/store/pg-refund-store.js';
import { Session } from '../../src/core/session.js';
import { agentEventToSse } from '../../src/server/sse.js';
import type { Database, SessionStore } from '../../src/store/types.js';
import type { AgentConfig, ChatProvider, ChatResponse } from '../../src/core/types.js';

/**
 * v1.1：所有端点都要凭证。这里签一把**带 admin 的**测试钥匙 ——
 * 本文件测的不是认证，用 admin 是为了让既有用例里 body 带 tenant_id 的写法继续成立
 *（代客操作，见 SPEC P16d）。认证与租户隔离本身由
 * `tests/server/auth.test.ts` 与 `tests/server/isolation.test.ts` 专门覆盖。
 */
let H: TestKey['headers'];


const usage = { inputTokens: 1, outputTokens: 1 };

const stubProvider: ChatProvider = {
  async chat(): Promise<ChatResponse> {
    return { content: 'ok', toolUses: [], usage, stopReason: 'end_turn' };
  },
  getModel: () => 'fake-model',
};

const config: AgentConfig = {
  model: 'fake-model',
  maxTurns: 3,
  maxTokensPerSession: 100_000,
  systemPrompt: '测试助手',
  confirmHighRisk: true,
};

describe('会话查询接口', () => {
  let db: Database;
  let app: FastifyInstance;
  let sessions: SessionStore;

  beforeAll(async () => {
    db = await openTestDb();
    H = (await seedKeyOn(db, { tenantId: 't_test', scopes: ['chat', 'read', 'write', 'admin'] })).headers;
    sessions = new PgSessionStore(db);
    app = await buildApp({
      stores: { ...(await makeTestStores(db)), sessions },
      config,
      provider: stubProvider,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  it('GET /v1/sessions/:id 返回元信息', async () => {
    const session = await Session.create(sessions, { userId: 'u1', tenantId: 't1' });
    await session.appendMessage({ role: 'user', content: 'q', timestamp: 1 });

    const res = await app.inject({ headers: H, method: 'GET', url: `/v1/sessions/${session.getId()}` });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      session_id: session.getId(),
      user_id: 'u1',
      tenant_id: 't1',
      message_count: 1,
    });
  });

  it('GET /v1/sessions/:id 不存在 → 404', async () => {
    const res = await app.inject({ headers: H, method: 'GET', url: '/v1/sessions/nope' });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('session_not_found');
  });

  it('GET /v1/sessions/:id/messages 返回完整历史（含工具消息配对信息）', async () => {
    const session = await Session.create(sessions);
    await session.appendMessage({ role: 'user', content: '查订单', timestamp: 1 });
    await session.appendMessage({
      role: 'assistant',
      content: '',
      toolUses: [{ id: 'tu_1', name: 'order_lookup', input: {} }],
      timestamp: 2,
    });
    await session.appendToolResult({
      toolUseId: 'tu_1',
      result: { content: '已发货' },
      durationMs: 3,
    });

    const res = await app.inject({ headers: H,
      method: 'GET',
      url: `/v1/sessions/${session.getId()}/messages`,
    });

    const body = JSON.parse(res.body);
    expect(body.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(body.messages[1].tool_uses).toEqual([{ id: 'tu_1', name: 'order_lookup' }]);
    expect(body.messages[2].tool_use_id).toBe('tu_1');
  });

  it('GET /v1/sessions/:id/messages 不存在 → 404', async () => {
    const res = await app.inject({ headers: H, method: 'GET', url: '/v1/sessions/nope/messages' });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /v1/agents', () => {
  let db: Database;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await openTestDb();
    H = (await seedKeyOn(db, { tenantId: 't_test', scopes: ['chat', 'read', 'write', 'admin'] })).headers;
    app = await buildApp({ stores: await makeTestStores(db), config, provider: stubProvider });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('返回全部领域 Agent 及其意图与工具', async () => {
    const res = await app.inject({ headers: H, method: 'GET', url: '/v1/agents' });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.agents.length).toBeGreaterThanOrEqual(5);

    const ids = body.agents.map((a: any) => a.id);
    expect(ids).toEqual(expect.arrayContaining(['presale', 'order', 'aftersale', 'general']));

    // 兜底 Agent 的工具面用 * 表示全集
    const general = body.agents.find((a: any) => a.id === 'general');
    expect(general.tools).toBe('*');
  });
});

describe('GET /healthz', () => {
  let db: Database;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await openTestDb();
    H = (await seedKeyOn(db, { tenantId: 't_test', scopes: ['chat', 'read', 'write', 'admin'] })).headers;
    app = await buildApp({
      stores: await makeTestStores(db),
      config,
      provider: stubProvider,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('存储可用时 200 并报告引擎', async () => {
    const res = await app.inject({ headers: H, method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: 'ok', engine: 'pglite', cache: 'noop' });
  });

  it('存储不可用时 503（而不是 200 骗上游）', async () => {
    const brokenDb = {
      ...db,
      engine: 'pglite' as const,
      query: async () => {
        throw new Error('connection refused');
      },
    };
    const brokenApp = await buildApp({
      stores: await makeTestStores(brokenDb as Database),
      config,
      provider: stubProvider,
    });
    await brokenApp.ready();

    const res = await brokenApp.inject({ headers: H, method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error.code).toBe('storage_unavailable');

    await brokenApp.close();
  });
});

describe('agentEventToSse', () => {
  it('每种 AgentEvent 都有对应的 SSE 事件名（1:1，无需映射表）', () => {
    const cases: Array<[any, string]> = [
      [{ type: 'delta', text: 'x' }, 'delta'],
      [{ type: 'thinking', content: 'c' }, 'thinking'],
      [{ type: 'tool_start', toolName: 't', input: {} }, 'tool_start'],
      [
        { type: 'tool_end', toolName: 't', result: { content: 'r' }, durationMs: 1 },
        'tool_end',
      ],
      [{ type: 'response', content: 'r' }, 'response'],
      [{ type: 'blocked', by: 'input-filter', reason: 'r' }, 'blocked'],
      [{ type: 'error', error: 'e' }, 'error'],
      [
        {
          type: 'done',
          totalTokens: { inputTokens: 1, outputTokens: 2 },
          totalCost: 0.001,
        },
        'done',
      ],
    ];

    for (const [event, expectedName] of cases) {
      expect(agentEventToSse(event)).toMatch(new RegExp(`^event: ${expectedName}\\n`));
    }
  });

  it('data 是单行 JSON（SSE 规范不允许裸换行）', () => {
    const frame = agentEventToSse({ type: 'delta', text: '第一行\n第二行' } as any);
    const dataLines = frame.split('\n').filter((l) => l.startsWith('data: '));
    expect(dataLines).toHaveLength(1);
    expect(JSON.parse(dataLines[0].slice(6)).text).toBe('第一行\n第二行');
  });
});
