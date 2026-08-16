import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import { buildToolService } from '../../src/tool-service/app.js';
import { RemoteToolGateway } from '../../src/tools/remote-gateway.js';
import {
  MemorySpanExporter,
  Tracer,
  formatTraceparent,
  newSpanId,
  newTraceId,
} from '../../src/observability/tracing.js';
import { openTestDb, truncateAll, makeTestStores } from '../store/helpers.js';
import { seedKey, clientFor, type TestKey, type TestClient } from './helpers.js';
import type { Database } from '../../src/store/types.js';
import type { Stores } from '../../src/store/index.js';
import type { AgentConfig, AgentTool, ChatProvider, ChatResponse } from '../../src/core/types.js';

const usage = { inputTokens: 10, outputTokens: 5 };

class ToolProvider implements ChatProvider {
  calledTool = false;
  shouldThrow = false;

  async chat(system: string, messages: any[], _t: AgentTool[]): Promise<ChatResponse> {
    if (system.includes('意图识别模块')) {
      return { content: '无法判断', toolUses: [], usage, stopReason: 'end_turn' };
    }
    if (this.shouldThrow) throw new Error('模型炸了');

    const last = messages[messages.length - 1];
    if (last?.role === 'tool' || this.calledTool) {
      return { content: '查到了', toolUses: [], usage, stopReason: 'end_turn' };
    }
    this.calledTool = true;
    return {
      content: '',
      toolUses: [{ id: 't1', name: 'order_lookup', input: { orderId: 'ORD-20260801-001' } }],
      usage,
      stopReason: 'tool_use',
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

const flush = () => new Promise((r) => setTimeout(r, 10));

describe('追踪 · 端到端', () => {
  let db: Database;
  let stores: Stores;
  let app: FastifyInstance;
  let provider: ToolProvider;
  let spans: MemorySpanExporter;
  let key: TestKey;
  let client: TestClient;

  beforeAll(async () => {
    db = await openTestDb();
    stores = await makeTestStores(db);
    provider = new ToolProvider();
    spans = new MemorySpanExporter();
    app = await buildApp({
      stores,
      config,
      provider,
      spanBuffer: spans,
      tracer: new Tracer({ exporter: spans }),
    });
    client = clientFor(app, () => key);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
    spans.clear();
    provider.calledTool = false;
    provider.shouldThrow = false;
    key = await seedKey(stores, { tenantId: 't_acme' });
  });

  it('🔴 P16/P17 一次对话产出 http/model/tool 三类 span，同 traceId 且父子正确', async () => {
    const res = await client.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '查订单' },
    });
    await flush();

    const traceId = res.headers['x-trace-id'] as string;
    const list = spans.byTrace(traceId);
    const names = list.map((s) => s.name);

    expect(names).toContain('http.chat.sync');
    expect(names).toContain('model.chat');
    expect(names).toContain('tool.execute');

    const http = list.find((s) => s.name === 'http.chat.sync')!;
    const tool = list.find((s) => s.name === 'tool.execute')!;
    // 父子关系错了，链路图就散成一堆孤立的点
    expect(tool.parentSpanId).toBe(http.spanId);
    expect(http.parentSpanId).toBeUndefined();
  });

  it('P18 span 有耗时', async () => {
    const res = await client.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '查订单' },
    });
    await flush();

    for (const s of spans.byTrace(res.headers['x-trace-id'] as string)) {
      expect(s.endTime).toBeGreaterThanOrEqual(s.startTime);
    }
  });

  it('🔴 P19 模型失败时 model span 标 error，http span 也标 error', async () => {
    provider.shouldThrow = true;
    const res = await client.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '会失败' },
    });
    await flush();

    expect(res.statusCode).toBe(502);
    const list = spans.byTrace(res.headers['x-trace-id'] as string);
    expect(list.find((s) => s.name === 'model.chat')!.status).toBe('error');
    expect(list.find((s) => s.name === 'http.chat.sync')!.status).toBe('error');
  });

  it('🔴 接住上游 traceparent —— 同一次用户操作不该在链路图上断成两截', async () => {
    const upstreamTrace = newTraceId();
    const upstreamSpan = newSpanId();

    const res = await client.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '你好' },
      headers: { traceparent: formatTraceparent(upstreamTrace, upstreamSpan) },
    });
    await flush();

    expect(res.headers['x-trace-id']).toBe(upstreamTrace);
    const http = spans.byTrace(upstreamTrace).find((s) => s.name === 'http.chat.sync')!;
    expect(http.parentSpanId).toBe(upstreamSpan);
  });

  it('畸形的 traceparent 不影响请求，只是另起一条链路', async () => {
    const res = await client.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '你好' },
      headers: { traceparent: '这不是一个合法的头' },
    });

    // 追踪是观测，不是依赖
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-trace-id']).toMatch(/^[0-9a-f]{32}$/);
  });

  it('SSE 端点同样产出 span', async () => {
    const res = await client.inject({
      method: 'POST',
      url: '/v1/chat',
      payload: { message: '查订单' },
    });
    await flush();

    const list = spans.byTrace(res.headers['x-trace-id'] as string);
    expect(list.map((s) => s.name)).toContain('http.chat.stream');
  });

  it('🔴 P23 GET /v1/traces/:id 返回链路，越权按 404', async () => {
    const res = await client.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '查订单' },
    });
    await flush();
    const traceId = res.headers['x-trace-id'] as string;

    const trace = await client.inject({ method: 'GET', url: `/v1/traces/${traceId}` });
    expect(trace.statusCode).toBe(200);
    expect(trace.json().spans.length).toBeGreaterThanOrEqual(3);
    // 相对偏移比绝对时间戳好读 —— 看链路时关心的是"第几毫秒发生了什么"
    expect(trace.json().spans[0].offset_ms).toBe(0);

    const other = await seedKey(stores, { tenantId: 't_globex' });
    const leak = await app.inject({
      method: 'GET',
      url: `/v1/traces/${traceId}`,
      headers: other.headers,
    });
    expect(leak.statusCode).toBe(404);
  });

  it('不存在的链路 → 404', async () => {
    const res = await client.inject({ method: 'GET', url: `/v1/traces/${newTraceId()}` });
    expect(res.statusCode).toBe(404);
  });

  it('/healthz 暴露 tracing 档位', async () => {
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).json();
    expect(['memory', 'otlp', 'off', 'memory+otlp']).toContain(body.tracing);
  });
});

describe('🔴 P20 跨进程传播（拆分形态）', () => {
  let db: Database;
  let stores: Stores;
  let svc: FastifyInstance;
  let app: FastifyInstance;
  let spans: MemorySpanExporter;
  let key: TestKey;

  beforeAll(async () => {
    db = await openTestDb();
    stores = await makeTestStores(db);
    spans = new MemorySpanExporter();
    const tracer = new Tracer({ exporter: spans });

    // 编排层与工具服务**共用一个内存缓冲**，模拟同一个 collector 收两边的 span
    svc = await buildToolService({ stores, tracer });
    app = await buildApp({
      stores,
      config,
      provider: new ToolProvider(),
      tracer,
      spanBuffer: spans,
      toolGateway: new RemoteToolGateway({
        async request({ method, path, headers, body }) {
          const r = await svc.inject({
            method,
            url: path,
            headers,
            payload: body as any,
          });
          return { status: r.statusCode, body: r.body };
        },
      }),
    });
    await app.ready();
    key = await seedKey(stores, { tenantId: 't_acme' });
  });

  afterAll(async () => {
    await app.close();
    await svc.close();
    await db.close();
  });

  it('工具服务里的 span 与编排层同 traceId，且挂在调用方 span 下面', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '查订单' },
      headers: key.headers,
    });
    await flush();

    const traceId = res.headers['x-trace-id'] as string;
    const list = spans.byTrace(traceId);

    const caller = list.find((s) => s.name === 'tool.execute');
    const callee = list.find((s) => s.name === 'tool.service.execute');

    expect(caller).toBeTruthy();
    // 没有这一条，拆开之后两边各有一堆互不相干的 span，
    // 谁也说不清一次请求到底经过了什么
    expect(callee).toBeTruthy();
    expect(callee!.traceId).toBe(traceId);
    expect(callee!.parentSpanId).toBe(caller!.spanId);
  });
});
