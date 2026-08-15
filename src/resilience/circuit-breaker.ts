export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitOptions {
  /** 连续失败多少次后打开 */
  failureThreshold: number;
  /** 打开后多久进入半开（毫秒） */
  cooldownMs: number;
  /** 半开时需要连续成功多少次才关闭 */
  successThreshold: number;
  /** 注入时钟便于测试 —— 用 sleep 等冷却会让用例又慢又不稳 */
  now?: () => number;
}

export const DEFAULT_CIRCUIT: CircuitOptions = {
  failureThreshold: 5,
  cooldownMs: 10_000,
  successThreshold: 2,
};

export class CircuitOpenError extends Error {
  readonly isCircuitOpen = true;
  constructor(public readonly retryAfterMs: number) {
    super(`熔断器已打开，${Math.ceil(retryAfterMs / 1000)} 秒后重试`);
    this.name = 'CircuitOpenError';
  }
}

/**
 * 熔断器。
 *
 * **它的价值不在「保护下游」，在保护自己。**
 * 下游挂了的时候，不熔断意味着每个请求都要等满超时时间 ——
 * 事件循环被一堆等死的请求占住，最后是**整个服务一起挂**，
 * 而不只是那一个功能不可用。
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private successes = 0;
  private openedAt = 0;
  private readonly now: () => number;

  constructor(private readonly opts: CircuitOptions = DEFAULT_CIRCUIT) {
    this.now = opts.now ?? Date.now;
  }

  getState(): CircuitState {
    // 冷却时间到了就自动进半开 —— 不需要外部定时器来推它
    if (this.state === 'open' && this.now() - this.openedAt >= this.opts.cooldownMs) {
      this.state = 'half_open';
      this.successes = 0;
    }
    return this.state;
  }

  /**
   * 包一次调用。
   *
   * 熔断打开时**直接抛错不执行** —— 这正是「快速失败」的含义：
   * 与其让调用方等满超时，不如立刻告诉它现在不可用。
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.getState();
    if (state === 'open') {
      throw new CircuitOpenError(this.opts.cooldownMs - (this.now() - this.openedAt));
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  /** 调用方自己判定成败时用（比如 HTTP 200 但业务失败） */
  onSuccess(): void {
    if (this.state === 'half_open') {
      this.successes++;
      if (this.successes >= this.opts.successThreshold) {
        this.state = 'closed';
        this.failures = 0;
        this.successes = 0;
      }
      return;
    }
    this.failures = 0;
  }

  onFailure(): void {
    // 半开时**一次失败就重新打开** —— 探针失败说明下游还没好，
    // 再放流量过去只是重复制造超时
    if (this.state === 'half_open') {
      this.trip();
      return;
    }

    this.failures++;
    if (this.failures >= this.opts.failureThreshold) this.trip();
  }

  private trip(): void {
    this.state = 'open';
    this.openedAt = this.now();
    this.successes = 0;
  }

  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.successes = 0;
    this.openedAt = 0;
  }

  get stats(): { state: CircuitState; failures: number } {
    return { state: this.getState(), failures: this.failures };
  }
}

// ============ 重试 ============

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  /** 判定这次失败值不值得重试。**默认不重试** —— 安全的一侧 */
  isRetryable?: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 100,
};

/**
 * 指数退避重试。
 *
 * ⚠️ **只对幂等且瞬时的失败重试。**
 * 重试一个可能已经生效的写操作，就是重复退款 —— 调用方必须自己判断，
 * 所以 `isRetryable` 缺省是「都不重试」而不是「都重试」：
 * 默认值要站在**出错时损失最小**的那一侧。
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = DEFAULT_RETRY
): Promise<T> {
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const retryable = opts.isRetryable ?? (() => false);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      // 熔断打开时立刻放弃 —— 重试只会一次次撞在同一堵墙上
      if (err instanceof CircuitOpenError) throw err;
      if (attempt >= opts.maxAttempts || !retryable(err)) throw err;
      await sleep(opts.baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastErr;
}

/** 网络类瞬时故障的判定：连接失败、超时、5xx */
export function isTransientError(err: unknown): boolean {
  const e = err as { name?: string; message?: string; status?: number };
  if (e?.name === 'AbortError') return true;
  if (typeof e?.status === 'number' && e.status >= 500) return true;
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed/i.test(
    e?.message ?? ''
  );
}
