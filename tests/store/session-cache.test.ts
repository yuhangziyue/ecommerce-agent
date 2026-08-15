import {
  CachedSessionStore,
  NoOpSessionCache,
  RedisSessionCache,
  createSessionCache,
} from '../../src/store/session-cache.js';
import { PgSessionStore } from '../../src/store/pg-session-store.js';
import { openTestDb, truncateAll } from './helpers.js';
import type { Database, SessionStore } from '../../src/store/types.js';
import type { SessionEntry, Message } from '../../src/core/types.js';

// 测试用 Redis 跑在 6380（本机 6379 那个需要认证且密码未知）
const TEST_REDIS_URL = 'redis://127.0.0.1:6380';

const msg = (content: string): SessionEntry => ({
  type: 'message',
  data: { role: 'user', content, timestamp: Date.now() } as Message,
  timestamp: Date.now(),
});

/** 统计内层被真正打了多少次库 */
class CountingStore implements SessionStore {
  getEntriesCalls = 0;
  constructor(private readonly inner: SessionStore) {}
  create = (i?: any) => this.inner.create(i);
  get = (id: string) => this.inner.get(id);
  listByUser = (u: string, l?: number) => this.inner.listByUser(u, l);
  listByTenant = (t: string, l?: number) => this.inner.listByTenant(t, l);
  appendEntry = (s: string, e: SessionEntry) => this.inner.appendEntry(s, e);
  getEntries(sessionId: string) {
    this.getEntriesCalls++;
    return this.inner.getEntries(sessionId);
  }
}

describe('NoOpSessionCache · 缓存不可用时的降级路径', () => {
  let db: Database;

  beforeAll(async () => {
    db = await openTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  it('🔴 无缓存时服务照常工作（只是每次打库）', async () => {
    const counting = new CountingStore(new PgSessionStore(db));
    const store = new CachedSessionStore(counting, new NoOpSessionCache());

    const s = await store.create();
    await store.appendEntry(s.id, msg('hello'));

    expect(await store.getEntries(s.id)).toHaveLength(1);
    expect(await store.getEntries(s.id)).toHaveLength(1);
    // 全部 miss → 每次都打库
    expect(counting.getEntriesCalls).toBe(2);
  });

  it('createSessionCache 无 URL 时返回 NoOp', async () => {
    const cache = await createSessionCache();
    expect(cache.kind).toBe('noop');
  });

  it('🔴 createSessionCache 连不上 Redis 时降级为 NoOp（不抛错、不阻塞启动）', async () => {
    const cache = await createSessionCache('redis://127.0.0.1:6399'); // 无人监听
    expect(cache.kind).toBe('noop');
    await cache.close();
  });
});

describe('RedisSessionCache · 真实 Redis', () => {
  let db: Database;
  let cache: RedisSessionCache | null = null;
  let available = false;

  beforeAll(async () => {
    db = await openTestDb();
    try {
      cache = await RedisSessionCache.open(TEST_REDIS_URL);
      available = true;
    } catch {
      // 测试 Redis 没起来 —— 跳过这一组而不是让整个套件挂
      available = false;
    }
  });

  afterAll(async () => {
    await cache?.close();
    await db.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  it('命中缓存时不打库', async () => {
    if (!available) return;
    const counting = new CountingStore(new PgSessionStore(db));
    const store = new CachedSessionStore(counting, cache!);

    const s = await store.create();
    await store.appendEntry(s.id, msg('a'));

    await store.getEntries(s.id); // miss → 打库 + 回填
    await store.getEntries(s.id); // hit
    await store.getEntries(s.id); // hit

    expect(counting.getEntriesCalls).toBe(1);
  });

  it('🔴 写入后缓存失效（不会读到过期历史）', async () => {
    if (!available) return;
    const store = new CachedSessionStore(new PgSessionStore(db), cache!);

    const s = await store.create();
    await store.appendEntry(s.id, msg('第一条'));
    expect(await store.getEntries(s.id)).toHaveLength(1); // 回填缓存

    await store.appendEntry(s.id, msg('第二条')); // 应使缓存失效
    const entries = await store.getEntries(s.id);

    expect(entries).toHaveLength(2);
    expect((entries[1].data as Message).content).toBe('第二条');
  });

  it('不同会话的缓存互不干扰', async () => {
    if (!available) return;
    const store = new CachedSessionStore(new PgSessionStore(db), cache!);

    const a = await store.create();
    const b = await store.create();
    await store.appendEntry(a.id, msg('a-only'));
    await store.appendEntry(b.id, msg('b-only'));

    expect((await store.getEntries(a.id))[0].data).toMatchObject({ content: 'a-only' });
    expect((await store.getEntries(b.id))[0].data).toMatchObject({ content: 'b-only' });
  });

  it('缓存往返保真（entry 的 type 与顺序不变）', async () => {
    if (!available) return;
    const store = new CachedSessionStore(new PgSessionStore(db), cache!);

    const s = await store.create();
    await store.appendEntry(s.id, msg('m'));
    await store.appendEntry(s.id, {
      type: 'tool_result',
      data: { toolUseId: 'tu_1', result: { content: 'r' }, durationMs: 5 },
      timestamp: Date.now(),
    });

    await store.getEntries(s.id); // 回填
    const cached = await store.getEntries(s.id); // 从缓存读

    expect(cached.map((e) => e.type)).toEqual(['message', 'tool_result']);
  });

  it('🔴 Redis 中途故障时降级为 miss，不抛错', async () => {
    if (!available) return;
    const brokenRedis = {
      get: async () => {
        throw new Error('connection lost');
      },
      set: async () => {
        throw new Error('connection lost');
      },
      del: async () => {
        throw new Error('connection lost');
      },
      quit: async () => {},
    };
    // 直接构造一个内部 redis 已坏的实例
    const broken = Object.create(RedisSessionCache.prototype);
    Object.assign(broken, { redis: brokenRedis, ttlSeconds: 900, kind: 'redis' });

    const store = new CachedSessionStore(new PgSessionStore(db), broken);
    const s = await store.create();
    await store.appendEntry(s.id, msg('still works'));

    // 缓存全线报错，但读写照常
    const entries = await store.getEntries(s.id);
    expect(entries).toHaveLength(1);
  });
});
