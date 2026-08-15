import type { UsageStore } from '../store/types.js';

/**
 * 配额计数器。
 *
 * 两个实现：Redis（原子、快）与 DB 直读（慢、但永远正确）。
 * **不做内存实现** —— 内存计数器活不过一个进程，而「活不过一个请求」正是
 * v0.11 要修的那个 bug，再引入一个同类东西是自找麻烦。
 */
export interface QuotaCounter {
  readonly kind: 'redis' | 'db';
  /** 当前累计计费 token 数 */
  get(scope: QuotaScope, id: string): Promise<number>;
  /** 原子累加，返回累加后的新值 */
  add(scope: QuotaScope, id: string, tokens: number): Promise<number>;
  close(): Promise<void>;
}

export type QuotaScope = 'tenant' | 'session';

export interface QuotaLimits {
  /** 单会话累计上限。越限是可恢复的：换个会话继续 */
  perSession: number;
  /** 租户在计费周期内的累计上限。越限是商业事件 → 429 */
  perTenant: number;
}

export type QuotaVerdict =
  | { allowed: true; warning?: string; utilization: number }
  | {
      allowed: false;
      /** `session` 可恢复（换会话）；`tenant` 不可恢复（要提额/充值） */
      scope: QuotaScope;
      reason: string;
      utilization: number;
    };

/** 直接查库的计数器：正确但每次都打库。Redis 不可用时的兜底。 */
export class DbQuotaCounter implements QuotaCounter {
  readonly kind = 'db' as const;

  constructor(
    private readonly usage: UsageStore,
    /** 计费周期起点（毫秒）。undefined = 全时段累计 */
    private readonly since?: number
  ) {}

  async get(scope: QuotaScope, id: string): Promise<number> {
    const sum =
      scope === 'tenant'
        ? await this.usage.sumByTenant(id, this.since)
        : await this.usage.sumBySession(id);
    return sum.billableTokens;
  }

  /**
   * DB 模式下**不单独累加** —— 账本自己就是计数器，落一条账用量就涨了。
   * 这里回读一次真值，保证与 Redis 实现的返回语义一致。
   */
  async add(scope: QuotaScope, id: string, _tokens: number): Promise<number> {
    return this.get(scope, id);
  }

  async close(): Promise<void> {}
}

/**
 * Redis 计数器：`INCRBY` 天然原子且返回新值，不需要 Lua。
 *
 * 计数器是**账本的缓存而非真相** —— 键丢了就回库重建。
 * 所以这里不设 TTL 之外的持久化保证，也不做 AOF 依赖。
 */
export class RedisQuotaCounter implements QuotaCounter {
  readonly kind = 'redis' as const;

  private constructor(
    private readonly redis: any,
    private readonly fallback: DbQuotaCounter,
    private readonly ttlSeconds: number
  ) {}

  static async open(
    url: string,
    fallback: DbQuotaCounter,
    ttlSeconds = 86_400
  ): Promise<RedisQuotaCounter> {
    const { default: Redis } = await import('ioredis');
    const redis = new Redis(url, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      connectTimeout: 2000,
    });
    await redis.connect();
    await redis.ping();
    return new RedisQuotaCounter(redis, fallback, ttlSeconds);
  }

  private key(scope: QuotaScope, id: string): string {
    return `quota:${scope}:${id}`;
  }

  async get(scope: QuotaScope, id: string): Promise<number> {
    const key = this.key(scope, id);
    try {
      const raw = await this.redis.get(key);
      if (raw !== null) return Number(raw);

      // 冷启动/键过期：回库重建，再回填
      const truth = await this.fallback.get(scope, id);
      // NX：并发回填时只有第一个写入生效，避免把别人已累加的值覆盖回旧值
      await this.redis.set(key, String(truth), 'EX', this.ttlSeconds, 'NX');
      return truth;
    } catch (err) {
      console.warn(`[quota] Redis 读取失败，回库：${(err as Error).message}`);
      return this.fallback.get(scope, id);
    }
  }

  async add(scope: QuotaScope, id: string, tokens: number): Promise<number> {
    const key = this.key(scope, id);
    try {
      // 先确保键存在且是真值（否则从 0 开始累加会低估）
      await this.get(scope, id);
      const next = await this.redis.incrby(key, tokens);
      await this.redis.expire(key, this.ttlSeconds);
      return Number(next);
    } catch (err) {
      // **计数失败不能当作 0** —— 那等于免费送。回库拿真值。
      console.warn(`[quota] Redis 累加失败，回库：${(err as Error).message}`);
      return this.fallback.get(scope, id);
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

/** Redis 连不上就降级为 DB 计数器 —— 与 v0.7 的缓存降级同一原则：慢，但不停摆。 */
export async function createQuotaCounter(
  usage: UsageStore,
  redisUrl?: string,
  since?: number
): Promise<QuotaCounter> {
  const db = new DbQuotaCounter(usage, since);
  if (!redisUrl) return db;
  try {
    return await RedisQuotaCounter.open(redisUrl, db);
  } catch (err) {
    console.warn(
      `[quota] Redis 不可用（${(err as Error).message}），配额检查回退到直接查库`
    );
    return db;
  }
}

/**
 * 配额服务：两级检查 + 落账。
 *
 * ⚠️ **并发语义（诚实说明）**：采用「先检查、后扣减」，N 个并发请求可能同时
 * 通过检查再各自扣减，产生**超发**。超发上限 = 并发数 × 单轮最大用量。
 * 精确扣减需要预留-提交（reserve-then-commit），代价是要处理预留泄漏
 * （请求崩溃后额度悬空），对 token 计费来说不值得。
 * 这个上限有实测数字，见 REPORT。
 */
export class QuotaService {
  constructor(
    private readonly counter: QuotaCounter,
    private readonly limits: QuotaLimits,
    private readonly warningThreshold = 0.8
  ) {}

  async check(input: {
    tenantId?: string | null;
    sessionId: string;
  }): Promise<QuotaVerdict> {
    // 租户先查 —— 它不可恢复，应当优先于可恢复的会话级越限报出来
    if (input.tenantId && this.limits.perTenant > 0) {
      const used = await this.counter.get('tenant', input.tenantId);
      const utilization = used / this.limits.perTenant;
      if (utilization >= 1) {
        return {
          allowed: false,
          scope: 'tenant',
          reason:
            `租户配额已用尽（${used}/${this.limits.perTenant} tokens）。` +
            `请联系管理员提额，开新会话无法恢复。`,
          utilization,
        };
      }
    }

    if (this.limits.perSession > 0) {
      const used = await this.counter.get('session', input.sessionId);
      const utilization = used / this.limits.perSession;
      if (utilization >= 1) {
        return {
          allowed: false,
          scope: 'session',
          reason:
            `本次会话用量已达上限（${used}/${this.limits.perSession} tokens）。` +
            `请开启新会话继续。`,
          utilization,
        };
      }
      if (utilization >= this.warningThreshold) {
        return {
          allowed: true,
          utilization,
          warning: `会话用量已达 ${(utilization * 100).toFixed(1)}%（${used}/${this.limits.perSession}），接近上限。`,
        };
      }
      return { allowed: true, utilization };
    }

    return { allowed: true, utilization: 0 };
  }

  /** 落账后同步计数器。两级各加一次 —— 它们是独立的计数维度。 */
  async record(input: {
    tenantId?: string | null;
    sessionId: string;
    billableTokens: number;
  }): Promise<void> {
    await this.counter.add('session', input.sessionId, input.billableTokens);
    if (input.tenantId) {
      await this.counter.add('tenant', input.tenantId, input.billableTokens);
    }
  }
}
