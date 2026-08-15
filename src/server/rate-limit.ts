export interface RateLimitVerdict {
  allowed: boolean;
  /** 还要等多久才可能被放行（毫秒）。用于 `Retry-After` */
  retryAfterMs: number;
  remaining: number;
}

export interface RateLimiter {
  consume(key: string): Promise<RateLimitVerdict>;
  close(): Promise<void>;
  readonly kind: 'redis' | 'in-process' | 'off';
}

export interface RateLimitOptions {
  /** 每秒允许的请求数 */
  rps: number;
  /** 突发容量。缺省 = rps × 2 */
  burst?: number;
  /** 注入时钟便于测试 —— 用 sleep 等窗口会让用例又慢又不稳（沿用 v1.0 熔断器的做法） */
  now?: () => number;
}

/** 关掉限流。显式对象而不是 `undefined` —— 让"没限流"在代码里看得见 */
export class NoOpRateLimiter implements RateLimiter {
  readonly kind = 'off' as const;
  async consume(_key: string): Promise<RateLimitVerdict> {
    return { allowed: true, retryAfterMs: 0, remaining: Number.POSITIVE_INFINITY };
  }
  async close(): Promise<void> {}
}

/**
 * 进程内令牌桶。
 *
 * ⚠️ **多实例下每个实例一份桶** —— N 个实例等于 N 倍配额。
 * 这个事实必须暴露给运维（`/healthz` 里的 `rate_limit` 字段），
 * 「限流在多实例下失准」这件事，运维不知道就等于没有限流。
 */
export class InProcessRateLimiter implements RateLimiter {
  readonly kind = 'in-process' as const;
  private readonly buckets = new Map<string, { tokens: number; last: number }>();
  private readonly rps: number;
  private readonly burst: number;
  private readonly now: () => number;

  constructor(opts: RateLimitOptions) {
    this.rps = opts.rps;
    this.burst = opts.burst ?? opts.rps * 2;
    this.now = opts.now ?? Date.now;
  }

  async consume(key: string): Promise<RateLimitVerdict> {
    const t = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.burst, last: t };

    // 按流逝时间补充令牌，上限是 burst
    const refill = ((t - bucket.last) / 1000) * this.rps;
    bucket.tokens = Math.min(this.burst, bucket.tokens + refill);
    bucket.last = t;

    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      const waitMs = Math.ceil(((1 - bucket.tokens) / this.rps) * 1000);
      return { allowed: false, retryAfterMs: waitMs, remaining: 0 };
    }

    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return { allowed: true, retryAfterMs: 0, remaining: Math.floor(bucket.tokens) };
  }

  async close(): Promise<void> {
    this.buckets.clear();
  }
}

/**
 * Redis 固定窗口。
 *
 * ⚠️ **诚实说明**：固定窗口在窗口边界处最多放行 2× 速率
 *（前一窗口末尾打满 + 后一窗口开头打满）。
 * 滑动窗口的代价是每请求多次 Redis 往返，对限流这种「防失控」而非「精确计量」
 * 的用途不值得 —— 但这个上限必须写明，而不是假装它不存在。
 */
export class RedisRateLimiter implements RateLimiter {
  readonly kind = 'redis' as const;

  private constructor(
    private readonly redis: any,
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly fallback: RateLimiter
  ) {}

  static async open(
    url: string,
    opts: RateLimitOptions & { windowMs?: number }
  ): Promise<RedisRateLimiter> {
    const { default: Redis } = await import('ioredis');
    const redis = new Redis(url, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      connectTimeout: 2000,
    });
    await redis.connect();
    await redis.ping();

    const windowMs = opts.windowMs ?? 1000;
    const limit = Math.max(1, Math.round((opts.rps * windowMs) / 1000));
    return new RedisRateLimiter(redis, limit, windowMs, new InProcessRateLimiter(opts));
  }

  async consume(key: string): Promise<RateLimitVerdict> {
    const window = Math.floor(Date.now() / this.windowMs);
    const redisKey = `rl:${key}:${window}`;

    try {
      const count: number = await this.redis.incr(redisKey);
      if (count === 1) {
        // 只在第一次设过期 —— 每次都设会让窗口被不断续期，等于永不重置
        await this.redis.pexpire(redisKey, this.windowMs * 2);
      }

      if (count > this.limit) {
        const retryAfterMs = (window + 1) * this.windowMs - Date.now();
        return { allowed: false, retryAfterMs: Math.max(1, retryAfterMs), remaining: 0 };
      }
      return { allowed: true, retryAfterMs: 0, remaining: this.limit - count };
    } catch (err) {
      // Redis 挂了**降级到进程内限流而不是放行** —— 与缓存不同：
      // 缓存故障降级只是变慢，限流故障降级放行等于在故障期间敞开大门，
      // 而故障期恰恰是最需要限流的时候
      console.warn(`[ratelimit] Redis 失败，本次降级为进程内限流：${(err as Error).message}`);
      return this.fallback.consume(key);
    }
  }

  async close(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      /* 关闭失败无所谓 */
    }
  }
}

export async function createRateLimiter(
  opts: RateLimitOptions & { redisUrl?: string; enabled?: boolean }
): Promise<RateLimiter> {
  if (opts.enabled === false || opts.rps <= 0) return new NoOpRateLimiter();
  if (!opts.redisUrl) return new InProcessRateLimiter(opts);
  try {
    return await RedisRateLimiter.open(opts.redisUrl, opts);
  } catch (err) {
    console.warn(
      `[ratelimit] Redis 不可用（${(err as Error).message}），降级为进程内限流：多实例下配额是 N 倍`
    );
    return new InProcessRateLimiter(opts);
  }
}
