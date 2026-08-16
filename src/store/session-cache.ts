import type { SessionEntry } from '../core/types.js';
import type { SessionStore, SessionRecord, CreateSessionInput } from './types.js';

export interface SessionCache {
  get(sessionId: string): Promise<SessionEntry[] | null>;
  set(sessionId: string, entries: SessionEntry[]): Promise<void>;
  invalidate(sessionId: string): Promise<void>;
  close(): Promise<void>;
  readonly kind: 'redis' | 'noop';
}

/** 缓存不可用时的实现：全部 miss，直接打库。服务照常工作，只是慢一点。 */
export class NoOpSessionCache implements SessionCache {
  readonly kind = 'noop' as const;
  async get(): Promise<SessionEntry[] | null> {
    return null;
  }
  async set(): Promise<void> {}
  async invalidate(): Promise<void> {}
  async close(): Promise<void> {}
}

export class RedisSessionCache implements SessionCache {
  readonly kind = 'redis' as const;

  private constructor(
    private readonly redis: any,
    private readonly ttlSeconds: number
  ) {}

  static async open(url: string, ttlSeconds = 900): Promise<RedisSessionCache> {
    const { default: Redis } = await import('ioredis');
    const redis = new Redis(url, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      // 连不上就快速失败，不要拖住启动
      connectTimeout: 2000,
    });
    await redis.connect();
    await redis.ping();
    return new RedisSessionCache(redis, ttlSeconds);
  }

  private key(sessionId: string): string {
    return `sess:entries:${sessionId}`;
  }

  /**
   * 任何缓存异常都降级为 miss —— **绝不让缓存故障变成服务故障**。
   * 这是缓存层的第一原则：它是加速，不是依赖。
   */
  async get(sessionId: string): Promise<SessionEntry[] | null> {
    try {
      const raw = await this.redis.get(this.key(sessionId));
      return raw ? (JSON.parse(raw) as SessionEntry[]) : null;
    } catch (err) {
      console.warn(`[cache] 读取失败，降级为 miss：${(err as Error).message}`);
      return null;
    }
  }

  async set(sessionId: string, entries: SessionEntry[]): Promise<void> {
    try {
      await this.redis.set(
        this.key(sessionId),
        JSON.stringify(entries),
        'EX',
        this.ttlSeconds
      );
    } catch (err) {
      console.warn(`[cache] 写入失败，忽略：${(err as Error).message}`);
    }
  }

  async invalidate(sessionId: string): Promise<void> {
    try {
      await this.redis.del(this.key(sessionId));
    } catch (err) {
      console.warn(`[cache] 失效失败，忽略：${(err as Error).message}`);
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

/**
 * 按 `REDIS_URL` 选缓存实现。**连不上就用 NoOp**，不抛错、不阻塞启动。
 *
 * 本机的 Redis 需要认证且密码未知 —— 这个约束反而定下了正确的设计：
 * 缓存必须是可选加速，不能是启动前置条件。
 */
export async function createSessionCache(url?: string): Promise<SessionCache> {
  if (!url) return new NoOpSessionCache();
  try {
    return await RedisSessionCache.open(url);
  } catch (err) {
    console.warn(
      `[cache] Redis 不可用（${(err as Error).message}），降级为无缓存模式`
    );
    return new NoOpSessionCache();
  }
}

/**
 * 给任意 SessionStore 套一层缓存。
 *
 * 只缓存 `getEntries`（读放大最严重的操作 —— v0.6 每个 HTTP 请求都要读整个会话）。
 * **写入即失效**：不做增量合并，因为合并逻辑一旦有 bug 就是「读到过期历史」，
 * 而那类 bug 表现为模型行为诡异，极难定位。宁可多打一次库。
 */
export class CachedSessionStore implements SessionStore {
  constructor(
    private readonly inner: SessionStore,
    private readonly cache: SessionCache
  ) {}

  create(input?: CreateSessionInput): Promise<SessionRecord> {
    return this.inner.create(input);
  }

  get(id: string): Promise<SessionRecord | null> {
    return this.inner.get(id);
  }

  listByUser(userId: string, limit?: number): Promise<SessionRecord[]> {
    return this.inner.listByUser(userId, limit);
  }

  listByTenant(tenantId: string, limit?: number): Promise<SessionRecord[]> {
    return this.inner.listByTenant(tenantId, limit);
  }

  async appendEntry(sessionId: string, entry: SessionEntry): Promise<void> {
    await this.inner.appendEntry(sessionId, entry);
    await this.cache.invalidate(sessionId);
  }

  /**
   * 锁**不经过缓存**，直接打库（v1.2）。
   *
   * 缓存的第一原则是「它是加速，不是依赖」；而锁恰恰是不能被降级的东西 ——
   * 一个允许 miss 的锁不是锁。
   */
  acquireTurnLock(sessionId: string, ttlMs: number, now: number): Promise<boolean> {
    return this.inner.acquireTurnLock(sessionId, ttlMs, now);
  }

  releaseTurnLock(sessionId: string): Promise<void> {
    return this.inner.releaseTurnLock(sessionId);
  }

  async getEntries(sessionId: string): Promise<SessionEntry[]> {
    const cached = await this.cache.get(sessionId);
    if (cached) return cached;

    const entries = await this.inner.getEntries(sessionId);
    await this.cache.set(sessionId, entries);
    return entries;
  }
}
