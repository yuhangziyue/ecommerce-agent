import { randomBytes } from 'node:crypto';

/**
 * 分布式追踪（v1.2）。
 *
 * **刻意不引 `@opentelemetry/*`**，理由和不引 LangChain 一样：
 * 「一次请求由哪些段构成」是这个系统的核心资产，它该是可读、可测、可改的代码。
 * OTel SDK 的价值在自动埋点与生态 —— 而我们要埋的点一共四类
 *（http / pipeline / model / tool），自动埋点反而会把 `pg`、`fetch` 的噪声一起收进来。
 *
 * 但**导出协议用标准的 OTLP/HTTP JSON**：协议是公开的，真实 collector 照收。
 * 自造协议才是把自己锁死在自家生态里。
 */

export type SpanStatus = 'ok' | 'error';
export type SpanAttributes = Record<string, string | number | boolean>;

export interface SpanData {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** 毫秒时间戳 */
  startTime: number;
  endTime: number;
  status: SpanStatus;
  attributes: SpanAttributes;
  error?: string;
}

export interface SpanExporter {
  export(spans: SpanData[]): Promise<void>;
  readonly kind: string;
}

// ============ W3C trace context ============

/** 32 位十六进制。**W3C 规格**，不是自造格式 —— 工具服务日后可能被别的系统调用 */
export function newTraceId(): string {
  return randomBytes(16).toString('hex');
}

export function newSpanId(): string {
  return randomBytes(8).toString('hex');
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function formatTraceparent(traceId: string, spanId: string): string {
  // 末段 `01` = sampled。当前不做采样：没有真实流量数据就定采样率是拍脑袋
  return `00-${traceId}-${spanId}-01`;
}

/**
 * 解析上游传来的 `traceparent`。
 *
 * **格式不合法就当没有**，而不是报错：追踪是观测，
 * 一个畸形的头不该让业务请求失败。
 */
export function parseTraceparent(
  header: string | undefined
): { traceId: string; spanId: string } | null {
  if (!header) return null;
  const m = TRACEPARENT.exec(header.trim().toLowerCase());
  if (!m) return null;
  // 全 0 的 id 在规范里是无效值
  if (/^0+$/.test(m[1]) || /^0+$/.test(m[2])) return null;
  return { traceId: m[1], spanId: m[2] };
}

// ============ Span ============

export class Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly startTime: number;
  private attributes: SpanAttributes;
  private status: SpanStatus = 'ok';
  private error?: string;
  private ended = false;

  constructor(
    private readonly tracer: Tracer,
    input: {
      traceId: string;
      spanId: string;
      parentSpanId?: string;
      name: string;
      startTime: number;
      attributes?: SpanAttributes;
    }
  ) {
    this.traceId = input.traceId;
    this.spanId = input.spanId;
    this.parentSpanId = input.parentSpanId;
    this.name = input.name;
    this.startTime = input.startTime;
    this.attributes = { ...(input.attributes ?? {}) };
  }

  setAttribute(key: string, value: string | number | boolean): this {
    this.attributes[key] = value;
    return this;
  }

  recordError(err: unknown): this {
    this.status = 'error';
    this.error = err instanceof Error ? err.message : String(err);
    return this;
  }

  /** 重复 end 只算第一次 —— 否则 `finally` 里再兜一次会把耗时改掉 */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.tracer.finish({
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      startTime: this.startTime,
      endTime: this.tracer.now(),
      status: this.status,
      attributes: this.attributes,
      error: this.error,
    });
  }

  /** 传给下游服务的 W3C 头 */
  traceparent(): string {
    return formatTraceparent(this.traceId, this.spanId);
  }
}

// ============ Tracer ============

export interface TracerOptions {
  exporter?: SpanExporter;
  /** 注入时钟便于测试（沿用 v1.0 熔断器 / v1.1 限流的做法） */
  now?: () => number;
  enabled?: boolean;
}

export class Tracer {
  private readonly exporter?: SpanExporter;
  readonly now: () => number;
  readonly enabled: boolean;

  constructor(opts: TracerOptions = {}) {
    this.exporter = opts.exporter;
    this.now = opts.now ?? Date.now;
    this.enabled = opts.enabled ?? true;
  }

  get exporterKind(): string {
    return this.enabled && this.exporter ? this.exporter.kind : 'off';
  }

  startSpan(
    name: string,
    opts: {
      parent?: Span;
      traceId?: string;
      parentSpanId?: string;
      attributes?: SpanAttributes;
    } = {}
  ): Span {
    const traceId = opts.parent?.traceId ?? opts.traceId ?? newTraceId();
    const parentSpanId = opts.parent?.spanId ?? opts.parentSpanId;
    return new Span(this, {
      traceId,
      spanId: newSpanId(),
      parentSpanId,
      name,
      startTime: this.now(),
      attributes: opts.attributes,
    });
  }

  /**
   * Span 结束时的落地。
   *
   * **导出失败一律吞掉**：追踪是观测，不是依赖。
   * 让一个 collector 故障拖垮业务请求，是把观测手段变成了故障源。
   */
  finish(span: SpanData): void {
    if (!this.enabled || !this.exporter) return;
    void this.exporter.export([span]).catch((err) => {
      console.warn(`[tracing] 导出失败，已忽略：${(err as Error).message}`);
    });
  }
}

// ============ 导出器 ============

/**
 * 内存环形缓冲。
 *
 * 让 `/v1/traces/:id` 在没有 collector 的环境下也能直接看到链路。
 * **有上限**：无界缓冲就是一个慢速内存泄漏，它会在压测第三小时才暴露。
 */
export class MemorySpanExporter implements SpanExporter {
  readonly kind = 'memory' as const;
  private readonly buffer: SpanData[] = [];

  constructor(private readonly capacity = 2000) {}

  async export(spans: SpanData[]): Promise<void> {
    for (const s of spans) {
      this.buffer.push(s);
      if (this.buffer.length > this.capacity) this.buffer.shift();
    }
  }

  byTrace(traceId: string): SpanData[] {
    return this.buffer
      .filter((s) => s.traceId === traceId)
      .sort((a, b) => a.startTime - b.startTime);
  }

  get size(): number {
    return this.buffer.length;
  }

  clear(): void {
    this.buffer.length = 0;
  }
}

/**
 * OTLP/HTTP + JSON 导出器。
 *
 * 结构必须严格符合 OTLP：`resourceSpans → scopeSpans → spans`，
 * 时间是**纳秒的字符串**（JS 的 number 装不下纳秒精度的时间戳，
 * 规范因此要求用字符串 —— 用 number 会静默丢精度）。
 */
export class OtlpHttpExporter implements SpanExporter {
  readonly kind = 'otlp' as const;

  constructor(
    private readonly endpoint: string,
    private readonly serviceName = 'ecommerce-agent',
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 3000
  ) {}

  async export(spans: SpanData[]): Promise<void> {
    if (spans.length === 0) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toOtlpPayload(spans, this.serviceName)),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

export function toOtlpPayload(spans: SpanData[], serviceName: string): unknown {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: serviceName } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'ecommerce-agent/tracing', version: '1.2' },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: 1, // SPAN_KIND_INTERNAL
              // 纳秒字符串 —— number 装不下，会静默丢精度
              startTimeUnixNano: `${s.startTime}000000`,
              endTimeUnixNano: `${s.endTime}000000`,
              attributes: Object.entries(s.attributes).map(([key, value]) => ({
                key,
                value: otlpValue(value),
              })),
              status:
                s.status === 'error'
                  ? { code: 2, message: s.error ?? '' } // STATUS_CODE_ERROR
                  : { code: 1 }, // STATUS_CODE_OK
            })),
          },
        ],
      },
    ],
  };
}

function otlpValue(v: string | number | boolean) {
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  }
  return { stringValue: v };
}

/** 同时写多个导出器（内存供 `/v1/traces` 查看，OTLP 供真实 collector） */
export class MultiSpanExporter implements SpanExporter {
  readonly kind: string;
  constructor(private readonly exporters: SpanExporter[]) {
    this.kind = exporters.map((e) => e.kind).join('+') || 'off';
  }
  async export(spans: SpanData[]): Promise<void> {
    // 一个导出器失败不该影响另一个 —— 用 allSettled 而不是 all
    await Promise.allSettled(this.exporters.map((e) => e.export(spans)));
  }
}
