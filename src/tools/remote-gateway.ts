import { newSpanId, type ToolDescriptor, type ToolGateway, type ValidationResult } from './gateway.js';
import {
  CircuitBreaker,
  CircuitOpenError,
  DEFAULT_CIRCUIT,
  DEFAULT_RETRY,
  isTransientError,
  withRetry,
  type CircuitOptions,
  type RetryOptions,
} from '../resilience/circuit-breaker.js';
import type { ToolContext, ToolResult } from '../core/types.js';

/** 能发请求的最小抽象。测试注入 Fastify 的 `inject`，生产用 `fetch`。 */
export interface HttpTransport {
  request(input: {
    method: 'GET' | 'POST';
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
  }): Promise<{ status: number; body: string }>;
}

export class FetchTransport implements HttpTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 10_000,
    /** v1.1 工具服务的共享密钥（`TOOL_SERVICE_TOKEN`）。不设则不带 */
    private readonly authToken?: string
  ) {}

  async request(input: {
    method: 'GET' | 'POST';
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
  }): Promise<{ status: number; body: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${input.path}`, {
        method: input.method,
        headers: {
          'Content-Type': 'application/json',
          ...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {}),
          ...(input.headers ?? {}),
        },
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: controller.signal,
      });
      return { status: res.status, body: await res.text() };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * 远程工具网关。
 *
 * ⚠️ **错误语义是这个类最重要的部分**：
 * 「工具服务连不上」和「工具执行失败」必须区分开。混为一谈的后果是 ——
 * 模型拿到「查询订单失败」，就会告诉客户「您的订单查不到」，
 * 而真相是我们自己的服务挂了。**基础设施故障不该被翻译成业务结论。**
 */
export class RemoteToolGateway implements ToolGateway {
  /** 工具表变动极少，缓存住 —— 每次规划都拉一次是纯浪费 */
  private cached: ToolDescriptor[] | null = null;
  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly transport: HttpTransport,
    private readonly opts: {
      cacheTools?: boolean;
      /** v1.0 韧性配置。缺省即启用熔断与重试 */
      circuit?: CircuitOptions;
      retry?: RetryOptions;
    } = {}
  ) {
    this.breaker = new CircuitBreaker(opts.circuit ?? DEFAULT_CIRCUIT);
  }

  get circuitState() {
    return this.breaker.getState();
  }

  async list(): Promise<ToolDescriptor[]> {
    if (this.opts.cacheTools !== false && this.cached) return this.cached;

    const res = await this.transport.request({ method: 'GET', path: '/v1/tools' });
    if (res.status !== 200) {
      throw new Error(`工具服务返回 ${res.status}，无法获取工具列表`);
    }
    const tools = JSON.parse(res.body).tools as ToolDescriptor[];
    if (this.opts.cacheTools !== false) this.cached = tools;
    return tools;
  }

  async get(name: string): Promise<ToolDescriptor | undefined> {
    return (await this.list()).find((t) => t.name === name);
  }

  /**
   * 本地按 schema 校验。
   *
   * 不为了校验多打一次网络 —— schema 已经在描述符里了。
   * 服务端**仍然会再校验一次**（它是独立端点，谁都能直接打），
   * 两侧都校验不是重复，是各自负责各自的入口。
   */
  async validate(
    name: string,
    input: Record<string, unknown>
  ): Promise<ValidationResult> {
    const tool = await this.get(name);
    if (!tool) return { ok: false, error: `Tool "${name}" not found` };

    const { default: Ajv } = await import('ajv');
    const ajv = new Ajv({ allErrors: true, strict: false });
    const fn = ajv.compile(tool.parameters as object);
    if (!fn(input)) return { ok: false, error: ajv.errorsText(fn.errors) };
    return { ok: true };
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolResult> {
    // ⚠️ **高风险工具永不重试。**
    // 重试一个可能已经生效的写操作就是重复退款 —— 一次超时可能只是响应丢了，
    // 而请求本身已经在下游执行完了。宁可让客户重来一次，也不能扣两次钱。
    const descriptor = await this.get(name).catch(() => undefined);
    const retryable = descriptor?.riskLevel !== 'high';

    const retryOpts: RetryOptions = {
      ...(this.opts.retry ?? DEFAULT_RETRY),
      maxAttempts: retryable ? (this.opts.retry ?? DEFAULT_RETRY).maxAttempts : 1,
      isRetryable: retryable ? isTransientError : () => false,
    };

    let res: { status: number; body: string };
    try {
      res = await withRetry(
        () =>
          this.breaker.run(async () => {
            const r = await this.transport.request({
              method: 'POST',
              path: '/v1/tools/execute',
              headers: {
                ...(ctx.traceId ? { 'x-trace-id': ctx.traceId } : {}),
                'x-span-id': newSpanId(),
              },
              body: { name, input, context: ctx },
            });
            // 5xx 要让熔断器看见 —— 只统计「连不上」会漏掉「连得上但一直报错」
            if (r.status >= 500) {
              const e = new Error(`工具服务返回 ${r.status}`) as Error & { status: number };
              e.status = r.status;
              throw e;
            }
            return r;
          }),
        retryOpts
      );
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        return {
          content:
            `工具服务当前不可用（已熔断，${Math.ceil(err.retryAfterMs / 1000)} 秒后自动重试），` +
            '本次操作未执行（不代表操作失败，也不代表数据不存在）。请告知客户系统维护中并转人工。',
          isError: true,
          metadata: { infrastructureError: true, circuitOpen: true },
        };
      }

      const status = (err as { status?: number }).status;
      if (typeof status === 'number' && status >= 500) {
        return {
          content:
            '工具服务内部错误，本次操作未执行（不代表操作失败）。请告知客户系统异常并转人工。',
          isError: true,
          metadata: { infrastructureError: true, status },
        };
      }
      const message = (err as Error).message;
      const timedOut = (err as Error).name === 'AbortError' || /abort/i.test(message);
      // 措辞要让模型知道**这不是业务结论** —— 否则它会告诉客户「查不到订单」
      return {
        content: timedOut
          ? `工具服务响应超时，本次操作未执行（不代表操作失败，也不代表数据不存在）。请告知客户系统繁忙，稍后重试或转人工。`
          : `工具服务暂时不可达，本次操作未执行（不代表操作失败，也不代表数据不存在）。请告知客户系统异常，稍后重试或转人工。`,
        isError: true,
        metadata: { infrastructureError: true, reason: message },
      };
    }

    if (res.status !== 200) {
      // 400/404 是**我们自己传错了**，属于业务层可理解的错误，如实转达
      const parsed = safeParse(res.body);
      return {
        content: parsed?.error?.message ?? `工具调用失败（HTTP ${res.status}）`,
        isError: true,
      };
    }

    const parsed = safeParse(res.body);
    if (!parsed?.result) {
      return {
        content: '工具服务返回了无法解析的响应，本次操作结果未知，请转人工核实。',
        isError: true,
        metadata: { infrastructureError: true },
      };
    }
    return parsed.result as ToolResult;
  }

  /** 工具表变了（部署新版工具服务）时调用 */
  invalidate(): void {
    this.cached = null;
  }
}

function safeParse(body: string): any | null {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
