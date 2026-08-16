import { describe, it, expect, vi } from 'vitest';
import {
  Tracer,
  MemorySpanExporter,
  MultiSpanExporter,
  OtlpHttpExporter,
  toOtlpPayload,
  formatTraceparent,
  parseTraceparent,
  newSpanId,
  newTraceId,
  type SpanData,
} from '../../src/observability/tracing.js';

/** 等一个微任务队列 —— 导出是 fire-and-forget 的 */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('W3C trace context', () => {
  it('id 是 32 / 16 位十六进制（规格要求）', () => {
    expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(newSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });

  it('traceparent 往返一致', () => {
    const traceId = newTraceId();
    const spanId = newSpanId();
    expect(parseTraceparent(formatTraceparent(traceId, spanId))).toEqual({
      traceId,
      spanId,
    });
  });

  it('大小写不敏感', () => {
    const h = formatTraceparent(newTraceId(), newSpanId()).toUpperCase();
    expect(parseTraceparent(h)).not.toBeNull();
  });

  it('🔴 畸形的头当作没有，而不是报错', () => {
    // 追踪是观测。一个畸形的头不该让业务请求失败
    for (const bad of [
      undefined,
      '',
      'garbage',
      '00-tooshort-abcdef0123456789-01',
      '99-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-01', // 不支持的版本
      '00-' + '0'.repeat(32) + '-' + 'b'.repeat(16) + '-01', // 全 0 traceId 无效
      '00-' + 'a'.repeat(32) + '-' + '0'.repeat(16) + '-01', // 全 0 spanId 无效
    ]) {
      expect(parseTraceparent(bad), String(bad)).toBeNull();
    }
  });
});

describe('Tracer · span 树', () => {
  const setup = () => {
    const exporter = new MemorySpanExporter();
    let t = 1000;
    const tracer = new Tracer({ exporter, now: () => t });
    return { exporter, tracer, tick: (ms: number) => (t += ms) };
  };

  it('span 记录耗时且 end > start', async () => {
    const { exporter, tracer, tick } = setup();
    const s = tracer.startSpan('http.request');
    tick(25);
    s.end();
    await flush();

    const [span] = exporter.byTrace(s.traceId);
    expect(span.endTime - span.startTime).toBe(25);
  });

  it('🔴 P17 子 span 继承 traceId，parent 指向父 span', async () => {
    const { exporter, tracer } = setup();
    const root = tracer.startSpan('http.request');
    const child = tracer.startSpan('tool.execute', { parent: root });
    child.end();
    root.end();
    await flush();

    const spans = exporter.byTrace(root.traceId);
    expect(spans).toHaveLength(2);
    const tool = spans.find((s) => s.name === 'tool.execute')!;
    // 父子关系错了，链路图就会散成一堆孤立的点
    expect(tool.traceId).toBe(root.traceId);
    expect(tool.parentSpanId).toBe(root.spanId);
  });

  it('根 span 没有 parentSpanId', async () => {
    const { exporter, tracer } = setup();
    const root = tracer.startSpan('http.request');
    root.end();
    await flush();
    expect(exporter.byTrace(root.traceId)[0].parentSpanId).toBeUndefined();
  });

  it('P19 失败的 span 标 error 并带错误信息', async () => {
    const { exporter, tracer } = setup();
    const s = tracer.startSpan('model.chat');
    s.recordError(new Error('connection reset'));
    s.end();
    await flush();

    const [span] = exporter.byTrace(s.traceId);
    expect(span.status).toBe('error');
    expect(span.error).toBe('connection reset');
  });

  it('🔴 重复 end 只算第一次（否则 finally 兜底会改掉耗时）', async () => {
    const { exporter, tracer, tick } = setup();
    const s = tracer.startSpan('x');
    tick(10);
    s.end();
    tick(500);
    s.end();
    await flush();

    expect(exporter.byTrace(s.traceId)).toHaveLength(1);
    expect(exporter.byTrace(s.traceId)[0].endTime - 1000).toBe(10);
  });

  it('属性可以挂上去', async () => {
    const { exporter, tracer } = setup();
    const s = tracer.startSpan('tool.execute', { attributes: { tool: 'order_lookup' } });
    s.setAttribute('duration_ms', 12).setAttribute('ok', true);
    s.end();
    await flush();

    expect(exporter.byTrace(s.traceId)[0].attributes).toEqual({
      tool: 'order_lookup',
      duration_ms: 12,
      ok: true,
    });
  });

  it('可以接住上游的 traceId 继续（跨进程的入口形态）', async () => {
    const { exporter, tracer } = setup();
    const upstream = { traceId: newTraceId(), spanId: newSpanId() };
    const s = tracer.startSpan('tool.execute', {
      traceId: upstream.traceId,
      parentSpanId: upstream.spanId,
    });
    s.end();
    await flush();

    const [span] = exporter.byTrace(upstream.traceId);
    expect(span.parentSpanId).toBe(upstream.spanId);
  });

  it('关闭时不产生任何 span', async () => {
    const exporter = new MemorySpanExporter();
    const tracer = new Tracer({ exporter, enabled: false });
    tracer.startSpan('x').end();
    await flush();
    expect(exporter.size).toBe(0);
    expect(tracer.exporterKind).toBe('off');
  });
});

describe('MemorySpanExporter', () => {
  it('🔴 P24 环形缓冲有上限，不会无限增长', async () => {
    // 无界缓冲是一个慢速内存泄漏 —— 它会在压测第三小时才暴露
    const exporter = new MemorySpanExporter(5);
    const tracer = new Tracer({ exporter });
    for (let i = 0; i < 50; i++) tracer.startSpan(`s${i}`).end();
    await flush();
    expect(exporter.size).toBe(5);
  });

  it('按 traceId 过滤，且按开始时间排序', async () => {
    const exporter = new MemorySpanExporter();
    let t = 0;
    const tracer = new Tracer({ exporter, now: () => t });

    const a = tracer.startSpan('a');
    t = 5;
    const b = tracer.startSpan('b', { parent: a });
    b.end();
    a.end();
    tracer.startSpan('别的链路').end();
    await flush();

    const spans = exporter.byTrace(a.traceId);
    expect(spans.map((s) => s.name)).toEqual(['a', 'b']);
  });
});

describe('OTLP 导出', () => {
  const span = (over: Partial<SpanData> = {}): SpanData => ({
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    name: 'model.chat',
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_000_120,
    status: 'ok',
    attributes: { model: 'fake', turns: 2, streamed: true, ratio: 0.5 },
    ...over,
  });

  it('🔴 P21 结构符合 OTLP：resourceSpans → scopeSpans → spans', () => {
    const payload = toOtlpPayload([span()], 'ecommerce-agent') as any;

    expect(payload.resourceSpans).toHaveLength(1);
    expect(payload.resourceSpans[0].resource.attributes).toContainEqual({
      key: 'service.name',
      value: { stringValue: 'ecommerce-agent' },
    });
    expect(payload.resourceSpans[0].scopeSpans[0].spans).toHaveLength(1);
  });

  it('🔴 时间是**纳秒字符串** —— number 装不下会静默丢精度', () => {
    const s = (toOtlpPayload([span()], 'x') as any).resourceSpans[0].scopeSpans[0]
      .spans[0];
    expect(s.startTimeUnixNano).toBe('1700000000000000000');
    expect(typeof s.startTimeUnixNano).toBe('string');
  });

  it('属性按类型映射（string / int / double / bool）', () => {
    const attrs = (toOtlpPayload([span()], 'x') as any).resourceSpans[0].scopeSpans[0]
      .spans[0].attributes;
    const by = (k: string) => attrs.find((a: any) => a.key === k).value;

    expect(by('model')).toEqual({ stringValue: 'fake' });
    expect(by('turns')).toEqual({ intValue: '2' });
    expect(by('streamed')).toEqual({ boolValue: true });
    expect(by('ratio')).toEqual({ doubleValue: 0.5 });
  });

  it('错误状态映射为 code 2 并带 message', () => {
    const s = (
      toOtlpPayload([span({ status: 'error', error: '炸了' })], 'x') as any
    ).resourceSpans[0].scopeSpans[0].spans[0];
    expect(s.status).toEqual({ code: 2, message: '炸了' });
  });

  it('POST 到 endpoint，Content-Type 是 application/json', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    const exporter = new OtlpHttpExporter(
      'http://collector:4318/v1/traces',
      'svc',
      fetchMock as unknown as typeof fetch
    );
    await exporter.export([span()]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toBe('http://collector:4318/v1/traces');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body).resourceSpans).toBeTruthy();
  });

  it('空数组不发请求', async () => {
    const fetchMock = vi.fn();
    await new OtlpHttpExporter('http://x', 'y', fetchMock as unknown as typeof fetch)
      .export([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('🔴 P22 导出失败不影响请求', () => {
  it('导出器抛错时 Tracer 吞掉，不向上冒泡', async () => {
    const broken = {
      kind: 'broken',
      export: async () => {
        throw new Error('collector 挂了');
      },
    };
    const tracer = new Tracer({ exporter: broken });

    // 让一个 collector 故障拖垮业务请求，是把观测手段变成了故障源
    expect(() => tracer.startSpan('x').end()).not.toThrow();
    await flush();
  });

  it('MultiSpanExporter：一个挂了另一个照样收到', async () => {
    const memory = new MemorySpanExporter();
    const broken = {
      kind: 'broken',
      export: async () => {
        throw new Error('挂了');
      },
    };
    const tracer = new Tracer({ exporter: new MultiSpanExporter([broken, memory]) });

    const s = tracer.startSpan('x');
    s.end();
    await flush();

    expect(memory.byTrace(s.traceId)).toHaveLength(1);
  });
});
