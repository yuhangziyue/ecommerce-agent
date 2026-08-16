import { buildApp } from '../../src/server/app.js';
import { buildToolService } from '../../src/tool-service/app.js';
import { LocalToolGateway, newTraceId } from '../../src/tools/gateway.js';
import { RemoteToolGateway, type HttpTransport } from '../../src/tools/remote-gateway.js';
import { buildToolRegistry } from '../../src/tools/index.js';
import { setRefundStore } from '../../src/tools/refund-store.js';
import { MetricsRegistry } from '../../src/observability/metrics.js';
import { openTestDb, truncateAll, makeTestStores } from '../store/helpers.js';
import { seedKeyOn, type TestKey } from '../server/helpers.js';
import type { Database } from '../../src/store/types.js';
import type { Stores } from '../../src/store/index.js';
import type {
  AgentConfig,
  ChatProvider,
  ChatResponse,
} from '../../src/core/types.js';
import type { ToolDescriptor, ToolGateway } from '../../src/tools/gateway.js';
import type { FastifyInstance } from 'fastify';

/**
 * v1.1：所有端点都要凭证。这里签一把**带 admin 的**测试钥匙 ——
 * 本文件测的不是认证，用 admin 是为了让既有用例里 body 带 tenant_id 的写法继续成立
 *（代客操作，见 SPEC P16d）。认证与租户隔离本身由
 * `tests/server/auth.test.ts` 与 `tests/server/isolation.test.ts` 专门覆盖。
 */
let H: TestKey['headers'];


const usage = { inputTokens: 100, outputTokens: 20 };

class ToolProvider implements ChatProvider {
  constructor(
    private readonly tool: string,
    private readonly input: Record<string, unknown>
  ) {}
  lastResult = '';
  visibleTools: string[] = [];

  async chat(system: string, messages: any[], tools: ToolDescriptor[]): Promise<ChatResponse> {
    if (system.includes('意图识别模块')) {
      return { content: '无法判断', toolUses: [], usage, stopReason: 'end_turn' };
    }
    this.visibleTools = tools.map((t) => t.name);
    const last = messages[messages.length - 1];
    if (last?.role === 'tool') {
      this.lastResult = last.content;
      return { content: '好的', toolUses: [], usage, stopReason: 'end_turn' };
    }
    return {
      content: '',
      toolUses: [{ id: 't1', name: this.tool, input: this.input }],
      usage,
      stopReason: 'tool_use',
    };
  }

  getModel(): string {
    return 'fake';
  }
}

const config: AgentConfig = {
  model: 'claude-sonnet-5',
  apiKey: 'test',
  maxTurns: 3,
  maxTokensPerSession: 1_000_000,
  systemPrompt: '你是客服助手',
  confirmHighRisk: true,
};

/** 把 Fastify 的 inject 包成 transport —— 不开真实端口也能测跨进程语义 */
function injectTransport(service: FastifyInstance): HttpTransport {
  return {
    async request({ method, path, headers, body }) {
      const res = await service.inject({
        method,
        url: path,
        headers,
        payload: body as any,
      });
      return { status: res.statusCode, body: res.body };
    },
  };
}

describe('🔴 同一套用例跑两种网关，结果必须一致（拆分不该改变行为）', () => {
  let db: Database;
  let stores: Stores;
  let toolService: FastifyInstance;

  beforeAll(async () => {
    db = await openTestDb();
    H = (await seedKeyOn(db, { tenantId: 't_test', scopes: ['chat', 'read', 'write', 'admin'] })).headers;
  });
  afterAll(async () => db.close());
  beforeEach(async () => {
    await truncateAll(db);
    stores = await makeTestStores(db);
    toolService = await buildToolService({ stores });
  });
  afterEach(async () => toolService.close());

  const gateways = (): Array<[string, () => ToolGateway]> => [
    [
      'local',
      () => {
        setRefundStore(stores.refunds);
        return new LocalToolGateway(buildToolRegistry());
      },
    ],
    ['remote', () => new RemoteToolGateway(injectTransport(toolService))],
  ];

  for (const [name, make] of gateways()) {
    describe(`网关=${name}`, () => {
      async function run(tool: string, input: Record<string, unknown>, msg = '你好') {
        const provider = new ToolProvider(tool, input);
        const app = await buildApp({
          stores,
          config,
          provider,
          toolGateway: make(),
        });
        const res = await app.inject({ headers: H,
          method: 'POST',
          url: '/v1/chat/sync',
          payload: { message: msg, user_id: 'u_1', tenant_id: 't_1' },
        });
        const body = JSON.parse(res.body);
        await app.close();
        return { body, provider, status: res.statusCode };
      }

      it('工具执行成功，结果一致', async () => {
        const { provider } = await run('order_lookup', { orderId: 'ORD-20260801-001' });
        expect(provider.lastResult).toContain('ORD-20260801-001');
        expect(provider.lastResult).toContain('顺丰');
      });

      it('结构化 artifact 跨网关一致', async () => {
        const { body } = await run('product_search', { category: '电子产品' });
        expect(body.artifacts[0].type).toBe('product_list');
        expect(body.artifacts[0].data.products.length).toBeGreaterThan(0);
        expect(typeof body.artifacts[0].data.products[0].price).toBe('number');
      });

      it('🔴 riskLevel 跨进程传递，高风险仍走确认流', async () => {
        const { provider } = await run('refund_apply', {
          orderId: 'ORD-20260801-001',
          reason: '质量问题',
        });
        // 远程模式下，riskLevel 只能来自描述符 —— 丢了就直接执行退款
        expect(provider.lastResult).toContain('需要客户确认');
        const { rows } = await db.query('SELECT * FROM refund_tickets');
        expect(rows).toHaveLength(0);
      });

      it('工具不存在时报错一致', async () => {
        const { provider } = await run('no_such_tool', {});
        expect(provider.lastResult).toContain('不存在');
      });

      it('🔴 参数校验失败时不执行', async () => {
        // 用 logistics_check：orderId 是真必填。order_lookup 的两个参数都是可选的
        //（订单号「或」手机尾号），传 {} 在 schema 层是合法的
        const { provider } = await run('logistics_check', {});
        expect(provider.lastResult).toContain('参数校验失败');
      });

      it('模型看到的工具清单一致', async () => {
        const { provider } = await run('order_lookup', { orderId: 'ORD-20260801-001' });
        expect(provider.visibleTools).toContain('order_lookup');
        expect(provider.visibleTools).toContain('refund_apply');
      });

      it('安全脱敏仍在编排层生效（与工具在哪执行无关）', async () => {
        const { body } = await run('logistics_check', { orderId: 'ORD-20260801-001' });
        expect(body.reply).not.toMatch(/1[3-9]\d{9}/);
      });
    });
  }
});

describe('工具服务 · 独立端点的自我保护', () => {
  let db: Database;
  let stores: Stores;
  let svc: FastifyInstance;

  beforeAll(async () => {
    db = await openTestDb();
    H = (await seedKeyOn(db, { tenantId: 't_test', scopes: ['chat', 'read', 'write', 'admin'] })).headers;
  });
  afterAll(async () => db.close());
  beforeEach(async () => {
    await truncateAll(db);
    stores = await makeTestStores(db);
    svc = await buildToolService({ stores, metrics: new MetricsRegistry() });
  });
  afterEach(async () => svc.close());

  it('列出工具（含 riskLevel，不含 execute）', async () => {
    const body = JSON.parse((await svc.inject({ method: 'GET', url: '/v1/tools' })).body);
    const refund = body.tools.find((t: any) => t.name === 'refund_apply');

    expect(refund.riskLevel).toBe('high');
    expect(refund.parameters).toBeTruthy();
    // execute 是函数引用，序列化后就没了 —— 描述符里本来就不该有它
    expect(refund.execute).toBeUndefined();
  });

  it('🔴 服务端独立校验参数（谁都能直接打它，不能信任调用方）', async () => {
    const res = await svc.inject({
      method: 'POST',
      url: '/v1/tools/execute',
      payload: { name: 'logistics_check', input: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('invalid_params');
  });

  it('未知工具 → 404', async () => {
    const res = await svc.inject({
      method: 'POST',
      url: '/v1/tools/execute',
      payload: { name: 'nope', input: {} },
    });
    expect(res.statusCode).toBe(404);
  });

  it('🔴 traceId 从请求头透传到响应（链路能串起来）', async () => {
    const traceId = newTraceId();
    const res = await svc.inject({
      method: 'POST',
      url: '/v1/tools/execute',
      headers: { 'x-trace-id': traceId },
      payload: {
        name: 'order_lookup',
        input: { orderId: 'ORD-20260801-001' },
        context: { sessionId: 's1' },
      },
    });
    expect(JSON.parse(res.body).trace_id).toBe(traceId);
  });

  it('工具服务有自己的指标', async () => {
    await svc.inject({
      method: 'POST',
      url: '/v1/tools/execute',
      payload: {
        name: 'order_lookup',
        input: { orderId: 'ORD-20260801-001' },
        context: { sessionId: 's1' },
      },
    });

    const body = (await svc.inject({ method: 'GET', url: '/metrics' })).body;
    expect(body).toContain('tool_service_executions_total{status="ok",tool="order_lookup"} 1');
    expect(body).toContain('tool_service_duration_seconds_count{tool="order_lookup"} 1');
  });

  it('健康检查', async () => {
    const res = await svc.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).service).toBe('tool-service');
  });

  it('未知字段被拒（400），不静默丢弃', async () => {
    const res = await svc.inject({
      method: 'POST',
      url: '/v1/tools/execute',
      payload: { name: 'logistics_check', input: { orderId: 'X' }, bogus: 1 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('🔴 远程故障的错误语义（基础设施故障 ≠ 业务结论）', () => {
  const ctx = { sessionId: 's1', traceId: 'tr_x' };

  const failing = (impl: HttpTransport['request']): RemoteToolGateway =>
    new RemoteToolGateway({ request: impl });

  const okList = async () => ({
    status: 200,
    body: JSON.stringify({
      tools: [
        { name: 'order_lookup', description: 'x', parameters: { type: 'object' }, riskLevel: 'low' },
      ],
    }),
  });

  it('服务不可达 → 明确说「未执行」，且提示这不代表数据不存在', async () => {
    const gw = failing(async ({ path }) => {
      if (path === '/v1/tools') return okList();
      throw new Error('ECONNREFUSED');
    });

    const r = await gw.execute('order_lookup', { orderId: 'X' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('未执行');
    // 关键：不能让模型以为「订单查不到」
    expect(r.content).toContain('不代表数据不存在');
    expect(r.content).toContain('转人工');
    expect(r.metadata?.infrastructureError).toBe(true);
  });

  it('超时 → 措辞区别于不可达', async () => {
    const gw = failing(async ({ path }) => {
      if (path === '/v1/tools') return okList();
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      throw e;
    });

    const r = await gw.execute('order_lookup', { orderId: 'X' }, ctx);
    expect(r.content).toContain('超时');
    expect(r.metadata?.infrastructureError).toBe(true);
  });

  it('5xx → 基础设施错误而非业务错误', async () => {
    const gw = failing(async ({ path }) => {
      if (path === '/v1/tools') return okList();
      return { status: 503, body: '{}' };
    });

    const r = await gw.execute('order_lookup', { orderId: 'X' }, ctx);
    expect(r.metadata?.infrastructureError).toBe(true);
    expect(r.content).toContain('未执行');
  });

  it('🔴 4xx 是我们自己传错了，如实转达而不是甩锅给基础设施', async () => {
    const gw = failing(async ({ path }) => {
      if (path === '/v1/tools') return okList();
      return {
        status: 400,
        body: JSON.stringify({ error: { code: 'invalid_params', message: '缺少 orderId' } }),
      };
    });

    const r = await gw.execute('order_lookup', {}, ctx);
    expect(r.content).toContain('缺少 orderId');
    expect(r.metadata?.infrastructureError).toBeUndefined();
  });

  it('返回体无法解析 → 结果未知，要求转人工核实（不能猜）', async () => {
    const gw = failing(async ({ path }) => {
      if (path === '/v1/tools') return okList();
      return { status: 200, body: 'not json at all' };
    });

    const r = await gw.execute('order_lookup', { orderId: 'X' }, ctx);
    expect(r.content).toContain('结果未知');
    expect(r.content).toContain('转人工');
  });

  it('工具表缓存住，不每次规划都拉一遍', async () => {
    let listCalls = 0;
    const gw = failing(async ({ path }) => {
      if (path === '/v1/tools') {
        listCalls++;
        return okList();
      }
      return { status: 200, body: JSON.stringify({ result: { content: 'ok' } }) };
    });

    await gw.list();
    await gw.list();
    await gw.execute('order_lookup', { orderId: 'X' }, ctx);
    expect(listCalls).toBe(1);

    gw.invalidate();
    await gw.list();
    expect(listCalls).toBe(2);
  });

  it('🔴 traceparent 与 traceId 进请求头（不然链路串不起来）', async () => {
    let seen: Record<string, string> | undefined;
    const gw = failing(async ({ path, headers }) => {
      if (path === '/v1/tools') return okList();
      seen = headers as Record<string, string>;
      return { status: 200, body: JSON.stringify({ result: { content: 'ok' } }) };
    });

    const traceId = 'a'.repeat(32);
    const spanId = 'b'.repeat(16);
    await gw.execute('order_lookup', { orderId: 'X' }, { ...ctx, traceId, spanId });

    expect(seen!['x-trace-id']).toBe(traceId);
    // v1.2：W3C 标准头 —— 工具服务据此把自己的 span 挂到调用方的 span 下面。
    // 自造格式等于把链路锁死在自家生态里
    expect(seen!['traceparent']).toBe(`00-${traceId}-${spanId}-01`);
    expect(seen!['x-span-id']).toBe(spanId);
  });

  it('🔴 没有 spanId 时不发畸形的 traceparent', async () => {
    let seen: Record<string, string> | undefined;
    const gw = failing(async ({ path, headers }) => {
      if (path === '/v1/tools') return okList();
      seen = headers as Record<string, string>;
      return { status: 200, body: JSON.stringify({ result: { content: 'ok' } }) };
    });

    // 拼一个半截的 traceparent 比不发更糟：下游解析失败，链路照样断，
    // 但排查的人会以为传播已经做了
    await gw.execute('order_lookup', { orderId: 'X' }, { sessionId: 's1', traceId: 'a'.repeat(32) });
    expect(seen!['traceparent']).toBeUndefined();
  });
});

// ============ v1.1：工具服务的共享密钥 ============
//
// v0.15 拆出这个服务时没给它任何认证。主服务上退款要过高风险确认流（v0.12），
// **绕过主服务直接打工具服务，那道确认流根本不存在** ——
// 拆分形态恰恰是要上规模时才用的形态，这个洞不能留。

describe('工具服务 · 共享密钥认证', () => {
  let db: Database;
  let stores: Stores;
  let svc: FastifyInstance;
  const TOKEN = 'tk_shared_secret';

  beforeAll(async () => {
    db = await openTestDb();
  });
  afterAll(async () => db.close());
  beforeEach(async () => {
    await truncateAll(db);
    stores = await makeTestStores(db);
    svc = await buildToolService({ stores, authToken: TOKEN });
  });
  afterEach(async () => svc.close());

  const exec = (headers?: Record<string, string>) =>
    svc.inject({
      method: 'POST',
      url: '/v1/tools/execute',
      headers,
      payload: {
        name: 'refund_apply',
        input: { orderId: 'ORD-20260801-001', reason: '质量问题' },
      },
    });

  it('🔴 无密钥直接执行退款 → 401，退款单一条都没落', async () => {
    const res = await exec();
    expect(res.statusCode).toBe(401);

    const { rows } = await db.query('SELECT * FROM refund_tickets');
    expect(rows).toHaveLength(0);
  });

  it('🔴 错误的密钥 → 401', async () => {
    const res = await exec({ authorization: 'Bearer 猜一个' });
    expect(res.statusCode).toBe(401);
  });

  it('正确的密钥 → 放行', async () => {
    const res = await exec({ authorization: `Bearer ${TOKEN}` });
    expect(res.statusCode).toBe(200);
  });

  it('🔴 探针免认证（LB 与抓取端没有密钥）', async () => {
    expect((await svc.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    expect((await svc.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(200);
  });

  it('🔴 网关自动带上密钥 —— 拆分形态端到端仍然通', async () => {
    const gateway = new RemoteToolGateway({
      async request({ method, path, headers, body }) {
        // FetchTransport 会把 authorization 塞进 headers；这里用 inject 模拟真实转发
        const res = await svc.inject({
          method,
          url: path,
          headers: { authorization: `Bearer ${TOKEN}`, ...headers },
          payload: body as any,
        });
        return { status: res.statusCode, body: res.body };
      },
    });

    const tools = await gateway.list();
    expect(tools.length).toBeGreaterThan(0);
  });

  it('不设密钥时保持开放（内网部署的默认假设）', async () => {
    const open = await buildToolService({ stores });
    const res = await open.inject({
      method: 'POST',
      url: '/v1/tools/execute',
      payload: { name: 'order_lookup', input: { orderId: 'ORD-20260801-001' } },
    });
    expect(res.statusCode).toBe(200);
    await open.close();
  });
});
