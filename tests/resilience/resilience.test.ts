import {
  CircuitBreaker,
  CircuitOpenError,
  withRetry,
  isTransientError,
} from '../../src/resilience/circuit-breaker.js';
import { RemoteToolGateway, type HttpTransport } from '../../src/tools/remote-gateway.js';
import { buildApp } from '../../src/server/app.js';
import { MetricsRegistry } from '../../src/observability/metrics.js';
import { buildMetrics, collectFrom } from '../../src/observability/collector.js';
import { EventBus } from '../../src/core/event-bus.js';
import { openTestDb, truncateAll, makeTestStores } from '../store/helpers.js';
import type { Database } from '../../src/store/types.js';
import type {
  AgentConfig,
  ChatOptions,
  ChatProvider,
  ChatResponse,
} from '../../src/core/types.js';
import type { ToolDescriptor } from '../../src/tools/gateway.js';

describe('CircuitBreaker · 三态转换', () => {
  let clock = 0;
  const make = (over = {}) =>
    new CircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 1000,
      successThreshold: 2,
      now: () => clock,
      ...over,
    });

  beforeEach(() => {
    clock = 0;
  });

  const fail = () => Promise.reject(new Error('boom'));
  const ok = () => Promise.resolve('ok');

  it('初始为关闭', () => {
    expect(make().getState()).toBe('closed');
  });

  it('🔴 连续失败达阈值 → 打开', async () => {
    const cb = make();
    for (let i = 0; i < 3; i++) await cb.run(fail).catch(() => {});
    expect(cb.getState()).toBe('open');
  });

  it('中间成功会重置失败计数（不是累计计数）', async () => {
    const cb = make();
    await cb.run(fail).catch(() => {});
    await cb.run(fail).catch(() => {});
    await cb.run(ok);
    await cb.run(fail).catch(() => {});
    expect(cb.getState()).toBe('closed');
  });

  it('🔴 打开时直接抛错，不执行下游（快速失败的全部意义）', async () => {
    const cb = make();
    for (let i = 0; i < 3; i++) await cb.run(fail).catch(() => {});

    let called = 0;
    await expect(
      cb.run(async () => {
        called++;
        return 'x';
      })
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(0);
  });

  it('冷却时间到 → 半开', async () => {
    const cb = make();
    for (let i = 0; i < 3; i++) await cb.run(fail).catch(() => {});
    clock += 1000;
    expect(cb.getState()).toBe('half_open');
  });

  it('🔴 半开时连续成功达阈值 → 关闭', async () => {
    const cb = make();
    for (let i = 0; i < 3; i++) await cb.run(fail).catch(() => {});
    clock += 1000;

    await cb.run(ok);
    expect(cb.getState()).toBe('half_open'); // 还差一次
    await cb.run(ok);
    expect(cb.getState()).toBe('closed');
  });

  it('🔴 半开时一次失败就重新打开（探针失败说明下游还没好）', async () => {
    const cb = make();
    for (let i = 0; i < 3; i++) await cb.run(fail).catch(() => {});
    clock += 1000;
    expect(cb.getState()).toBe('half_open');

    await cb.run(fail).catch(() => {});
    expect(cb.getState()).toBe('open');
  });

  it('重新打开后要再等一个完整冷却期', async () => {
    const cb = make();
    for (let i = 0; i < 3; i++) await cb.run(fail).catch(() => {});
    clock += 1000;
    await cb.run(fail).catch(() => {});

    clock += 999;
    expect(cb.getState()).toBe('open');
    clock += 1;
    expect(cb.getState()).toBe('half_open');
  });

  it('错误里带剩余冷却时间，便于告知调用方', async () => {
    const cb = make();
    for (let i = 0; i < 3; i++) await cb.run(fail).catch(() => {});
    clock += 400;

    const err = await cb.run(ok).catch((e) => e);
    expect(err).toBeInstanceOf(CircuitOpenError);
    expect((err as CircuitOpenError).retryAfterMs).toBe(600);
  });

  it('reset 回到初始态', async () => {
    const cb = make();
    for (let i = 0; i < 3; i++) await cb.run(fail).catch(() => {});
    cb.reset();
    expect(cb.getState()).toBe('closed');
  });
});

describe('withRetry · 默认站在损失最小的一侧', () => {
  const noSleep = async () => {};

  it('🔴 缺省不重试（默认值要站在出错时损失最小的一侧）', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error('ECONNREFUSED');
        },
        { maxAttempts: 3, baseDelayMs: 1, sleep: noSleep }
      )
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('声明可重试时，瞬时失败被跨过', async () => {
    let calls = 0;
    const r = await withRetry(
      async () => {
        calls++;
        if (calls < 2) throw new Error('ECONNREFUSED');
        return 'ok';
      },
      { maxAttempts: 3, baseDelayMs: 1, isRetryable: isTransientError, sleep: noSleep }
    );
    expect(r).toBe('ok');
    expect(calls).toBe(2);
  });

  it('重试次数封顶', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error('ECONNREFUSED');
        },
        { maxAttempts: 3, baseDelayMs: 1, isRetryable: isTransientError, sleep: noSleep }
      )
    ).rejects.toThrow();
    expect(calls).toBe(3);
  });

  it('指数退避（1x / 2x / 4x）', async () => {
    const delays: number[] = [];
    await withRetry(
      async (a) => {
        if (a < 4) throw new Error('ETIMEDOUT');
        return 'ok';
      },
      {
        maxAttempts: 4,
        baseDelayMs: 100,
        isRetryable: isTransientError,
        sleep: async (ms) => void delays.push(ms),
      }
    );
    expect(delays).toEqual([100, 200, 400]);
  });

  it('🔴 熔断打开时立刻放弃（重试只会一次次撞同一堵墙）', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new CircuitOpenError(5000);
        },
        { maxAttempts: 3, baseDelayMs: 1, isRetryable: () => true, sleep: noSleep }
      )
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls).toBe(1);
  });

  it('瞬时错误判定：连接类与 5xx 是，业务错误不是', () => {
    expect(isTransientError(new Error('ECONNREFUSED'))).toBe(true);
    expect(isTransientError(new Error('socket hang up'))).toBe(true);
    expect(isTransientError({ status: 503 })).toBe(true);
    expect(isTransientError({ name: 'AbortError' })).toBe(true);
    expect(isTransientError(new Error('订单不存在'))).toBe(false);
    expect(isTransientError({ status: 400 })).toBe(false);
  });
});

describe('🔴 远程网关的韧性：高风险工具永不重试', () => {
  const ctx = { sessionId: 's1', traceId: 'tr_1' };
  const tools: ToolDescriptor[] = [
    { name: 'order_lookup', description: 'x', parameters: { type: 'object' }, riskLevel: 'low' },
    { name: 'refund_apply', description: 'x', parameters: { type: 'object' }, riskLevel: 'high' },
  ];

  function gw(onExecute: () => Promise<{ status: number; body: string }>) {
    let executes = 0;
    const transport: HttpTransport = {
      async request({ path }) {
        if (path === '/v1/tools') {
          return { status: 200, body: JSON.stringify({ tools }) };
        }
        executes++;
        return onExecute();
      },
    };
    return {
      gateway: new RemoteToolGateway(transport, {
        retry: { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} },
      }),
      count: () => executes,
    };
  }

  it('低风险工具的瞬时失败被重试跨过', async () => {
    let n = 0;
    const { gateway, count } = gw(async () => {
      n++;
      if (n < 2) throw new Error('ECONNREFUSED');
      return { status: 200, body: JSON.stringify({ result: { content: 'ok' } }) };
    });

    const r = await gateway.execute('order_lookup', {}, ctx);
    expect(r.content).toBe('ok');
    expect(count()).toBe(2);
  });

  it('🔴🔴 高风险工具只调一次 —— 重试可能已生效的写操作就是重复退款', async () => {
    const { gateway, count } = gw(async () => {
      throw new Error('ECONNREFUSED');
    });

    const r = await gateway.execute('refund_apply', { orderId: 'X' }, ctx);
    expect(count()).toBe(1);
    expect(r.isError).toBe(true);
    expect(r.metadata?.infrastructureError).toBe(true);
  });

  it('🔴 高风险工具超时同样不重试（超时最可能是响应丢了而请求已执行）', async () => {
    const { gateway, count } = gw(async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    });

    await gateway.execute('refund_apply', { orderId: 'X' }, ctx);
    expect(count()).toBe(1);
  });

  it('4xx 不重试（不是瞬时错误）', async () => {
    const { gateway, count } = gw(async () => ({
      status: 400,
      body: JSON.stringify({ error: { message: '参数错' } }),
    }));

    await gateway.execute('order_lookup', {}, ctx);
    expect(count()).toBe(1);
  });

  it('🔴 连续失败后熔断打开，下游不再被打', async () => {
    const { gateway, count } = gw(async () => {
      throw new Error('ECONNREFUSED');
    });

    // 默认阈值 5 次失败；每次 execute 会重试 3 次 → 两次调用即打开
    await gateway.execute('order_lookup', {}, ctx);
    await gateway.execute('order_lookup', {}, ctx);
    expect(gateway.circuitState).toBe('open');

    const before = count();
    const r = await gateway.execute('order_lookup', {}, ctx);
    expect(count()).toBe(before); // 一次都没打下游
    expect(r.content).toContain('熔断');
    expect(r.metadata?.circuitOpen).toBe(true);
  });

  it('熔断后的措辞仍然说明「未执行、不代表数据不存在」', async () => {
    const { gateway } = gw(async () => {
      throw new Error('ECONNREFUSED');
    });
    await gateway.execute('order_lookup', {}, ctx);
    await gateway.execute('order_lookup', {}, ctx);

    const r = await gateway.execute('order_lookup', {}, ctx);
    expect(r.content).toContain('未执行');
    expect(r.content).toContain('不代表数据不存在');
    expect(r.content).toContain('转人工');
  });
});

describe('取消传播（还 v0.6 的账）', () => {
  let db: Database;

  beforeAll(async () => {
    db = await openTestDb();
  });
  afterAll(async () => db.close());
  beforeEach(async () => truncateAll(db));

  const config: AgentConfig = {
    model: 'claude-sonnet-5',
    apiKey: 'test',
    maxTurns: 3,
    maxTokensPerSession: 1_000_000,
    systemPrompt: '你是客服助手',
    confirmHighRisk: true,
  };

  /** 记录是否收到取消信号，并在被取消时像真 SDK 那样抛 AbortError */
  class AbortAwareProvider implements ChatProvider {
    sawSignal = false;
    aborted = false;
    calls = 0;

    async chat(
      system: string,
      _m: any[],
      _t: ToolDescriptor[],
      opts?: ChatOptions
    ): Promise<ChatResponse> {
      if (system.includes('意图识别模块')) {
        return {
          content: '无法判断',
          toolUses: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: 'end_turn',
        };
      }
      this.calls++;
      this.sawSignal = Boolean(opts?.signal);
      if (opts?.signal?.aborted) {
        this.aborted = true;
        const e = new Error('Request was aborted');
        e.name = 'AbortError';
        throw e;
      }
      return {
        content: '好的',
        toolUses: [],
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: 'end_turn',
      };
    }

    getModel(): string {
      return 'fake';
    }
  }

  it('🔴 SSE 路由把取消信号传给模型调用', async () => {
    const provider = new AbortAwareProvider();
    const app = await buildApp({ stores: await makeTestStores(db), config, provider });

    await app.inject({ method: 'POST', url: '/v1/chat', payload: { message: '你好' } });
    expect(provider.sawSignal).toBe(true);
    await app.close();
  });

  it('🔴 已取消时模型抛 AbortError → 记为 cancelled 而不是 error', () => {
    const reg = new MetricsRegistry();
    const metrics = buildMetrics(reg);
    const bus = new EventBus();
    collectFrom(bus, metrics);

    bus.emit({ type: 'cancelled', reason: '客户端已断开' });
    bus.emit({
      type: 'done',
      totalTokens: { inputTokens: 1, outputTokens: 0 },
      totalCost: 0,
    });

    expect(metrics.turns.get({ outcome: 'cancelled' })).toBe(1);
    // 用户关页面不是系统错误 —— 混进 error 会让错误率变噪声
    expect(metrics.turns.get({ outcome: 'error' })).toBe(0);
  });

  it('未取消时行为与 v0.15 完全一致（取消能力不该改变常态语义）', async () => {
    const provider = new AbortAwareProvider();
    const app = await buildApp({ stores: await makeTestStores(db), config, provider });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '你好' },
    });
    expect(JSON.parse(res.body).reply).toBe('好的');
    expect(provider.aborted).toBe(false);
    await app.close();
  });
});

describe('优雅退出 · draining', () => {
  let db: Database;

  beforeAll(async () => {
    db = await openTestDb();
  });
  afterAll(async () => db.close());
  beforeEach(async () => truncateAll(db));

  const config: AgentConfig = {
    model: 'claude-sonnet-5',
    apiKey: 'test',
    maxTurns: 3,
    maxTokensPerSession: 1_000_000,
    systemPrompt: 'x',
    confirmHighRisk: true,
  };

  class Simple implements ChatProvider {
    async chat(): Promise<ChatResponse> {
      return {
        content: '好的',
        toolUses: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end_turn',
      };
    }
    getModel(): string {
      return 'fake';
    }
  }

  it('正常时 /healthz 健康', async () => {
    const app = await buildApp({
      stores: await makeTestStores(db),
      config,
      provider: new Simple(),
    });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('ok');
    await app.close();
  });

  it('🔴 draining 后 /healthz 转 503，但在途请求仍能完成', async () => {
    const app = (await buildApp({
      stores: await makeTestStores(db),
      config,
      provider: new Simple(),
    })) as any;

    app.startDraining();

    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(503);
    expect(JSON.parse(health.body).status).toBe('draining');

    // 关键：不接新流量 ≠ 立刻停机。这两件事差着所有在途请求的成败
    const chat = await app.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '你好' },
    });
    expect(chat.statusCode).toBe(200);
    expect(JSON.parse(chat.body).reply).toBe('好的');

    await app.close();
  });

  it('健康检查报告工具网关模式（排查时先看这个）', async () => {
    const app = await buildApp({
      stores: await makeTestStores(db),
      config,
      provider: new Simple(),
    });
    const body = JSON.parse((await app.inject({ method: 'GET', url: '/healthz' })).body);
    expect(body.tool_gateway).toBe('local');
    await app.close();
  });
});
