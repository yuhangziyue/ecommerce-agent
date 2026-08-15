import { PgSessionStore } from '../../src/store/pg-session-store.js';
import { openTestDb, truncateAll } from './helpers.js';
import type { Database, SessionStore } from '../../src/store/types.js';
import type { SessionEntry, Message } from '../../src/core/types.js';

const msg = (content: string): SessionEntry => ({
  type: 'message',
  data: { role: 'user', content, timestamp: Date.now() } as Message,
  timestamp: Date.now(),
});

describe('PgSessionStore', () => {
  let db: Database;
  let store: SessionStore;

  beforeAll(async () => {
    db = await openTestDb();
    store = new PgSessionStore(db);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  describe('create / get', () => {
    it('创建会话并可读回', async () => {
      const created = await store.create({ userId: 'u1', tenantId: 't1' });

      expect(created.id).toBeTruthy();
      expect(created.userId).toBe('u1');
      expect(created.tenantId).toBe('t1');

      const loaded = await store.get(created.id);
      expect(loaded).toMatchObject({ id: created.id, userId: 'u1', tenantId: 't1' });
    });

    it('不带参数创建：userId / tenantId 为 null', async () => {
      const created = await store.create();
      expect(created.userId).toBeNull();
      expect(created.tenantId).toBeNull();
      expect(created.metadata).toEqual({});
    });

    it('metadata 往返保真（JSONB）', async () => {
      const created = await store.create({
        metadata: { channel: 'web', tags: ['vip', 'new'], score: 0.87 },
      });
      const loaded = await store.get(created.id);
      expect(loaded!.metadata).toEqual({
        channel: 'web',
        tags: ['vip', 'new'],
        score: 0.87,
      });
    });

    it('不存在的会话返回 null', async () => {
      expect(await store.get('no-such-session')).toBeNull();
    });

    it('可指定 id 创建（便于外部生成会话号）', async () => {
      const created = await store.create({ id: 'sesn-custom-1' });
      expect(created.id).toBe('sesn-custom-1');
      expect((await store.get('sesn-custom-1'))!.id).toBe('sesn-custom-1');
    });
  });

  describe('事件追加与读回', () => {
    it('按写入顺序读回', async () => {
      const s = await store.create();
      for (const c of ['a', 'b', 'c', 'd']) {
        await store.appendEntry(s.id, msg(c));
      }

      const entries = await store.getEntries(s.id);
      expect(entries.map((e) => (e.data as Message).content)).toEqual([
        'a',
        'b',
        'c',
        'd',
      ]);
    });

    it('不同会话的事件互不串台', async () => {
      const s1 = await store.create();
      const s2 = await store.create();
      await store.appendEntry(s1.id, msg('s1-only'));
      await store.appendEntry(s2.id, msg('s2-only'));

      expect(await store.getEntries(s1.id)).toHaveLength(1);
      expect((await store.getEntries(s1.id))[0].data).toMatchObject({
        content: 's1-only',
      });
    });

    it('保留 entry 的 type（投影逻辑依赖它）', async () => {
      const s = await store.create();
      await store.appendEntry(s.id, msg('m'));
      await store.appendEntry(s.id, {
        type: 'tool_result',
        data: { toolUseId: 'tu_1', result: { content: 'r' }, durationMs: 5 },
        timestamp: Date.now(),
      });

      const types = (await store.getEntries(s.id)).map((e) => e.type);
      expect(types).toEqual(['message', 'tool_result']);
    });

    it('🔴 并发追加 50 条不丢不乱序（JSONL 方案在此会产生半行）', async () => {
      const s = await store.create();

      // 并发发起 50 次追加。文件追加方案下多个写入交错会产生半行，
      // loadFromFile 只能跳过损坏行 —— 表现为静默丢消息。
      await Promise.all(
        Array.from({ length: 50 }, (_, i) => store.appendEntry(s.id, msg(`m${i}`)))
      );

      const entries = await store.getEntries(s.id);
      expect(entries).toHaveLength(50);

      // 一条都不能丢
      const contents = new Set(entries.map((e) => (e.data as Message).content));
      for (let i = 0; i < 50; i++) {
        expect(contents.has(`m${i}`)).toBe(true);
      }

      // seq 必须严格递增
      const seqs = entries.map((e) => e.timestamp);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    });

    it('🔴 排序只依赖写入序，与 created_at 无关（seq 作为排序依据的契约）', async () => {
      const s = await store.create();

      // 刻意让 created_at 与写入顺序**相反**：
      // 若排序依据是 created_at，返回顺序会被颠倒成 third/second/first；
      // 依据 seq 才保持写入顺序。这是可证伪的构造 ——
      //
      // 为什么这个契约重要：PostgreSQL 的 now() 返回**事务开始时间**，同一事务内
      // 多条插入的 created_at 完全相同；真实 PG 多连接并发时也会撞相同时间戳。
      // 而 v0.3 的投影逻辑对顺序敏感（tool_result 必须跟在产生它的 assistant 之后），
      // 顺序一错，restore 出的历史就会因配对错乱被 API 拒绝。
      await db.query(
        `INSERT INTO session_entries (session_id, type, data, created_at) VALUES
           ($1, 'message', '{"content":"first"}'::jsonb,  TIMESTAMPTZ '2026-08-15 00:00:03Z'),
           ($1, 'message', '{"content":"second"}'::jsonb, TIMESTAMPTZ '2026-08-15 00:00:02Z'),
           ($1, 'message', '{"content":"third"}'::jsonb,  TIMESTAMPTZ '2026-08-15 00:00:01Z')`,
        [s.id]
      );

      const entries = await store.getEntries(s.id);
      expect(
        entries.map((e) => (e.data as { content: string }).content)
      ).toEqual(['first', 'second', 'third']);

      const seqs = entries.map((e) => e.timestamp);
      expect(seqs[0]).toBeLessThan(seqs[1]);
      expect(seqs[1]).toBeLessThan(seqs[2]);
    });
  });

  describe('按用户 / 租户查询（JSONL 方案无法做到）', () => {
    it('listByUser 按创建时间倒序', async () => {
      const a = await store.create({ userId: 'u1' });
      const b = await store.create({ userId: 'u1' });
      await store.create({ userId: 'u2' });

      const list = await store.listByUser('u1');
      expect(list).toHaveLength(2);
      expect(list.map((s) => s.id)).toEqual([b.id, a.id]); // 最新在前
    });

    it('listByUser 支持 limit', async () => {
      for (let i = 0; i < 5; i++) await store.create({ userId: 'u1' });
      expect(await store.listByUser('u1', 2)).toHaveLength(2);
    });

    it('listByTenant 只返回该租户的会话（v0.11 计费聚合的基础）', async () => {
      await store.create({ tenantId: 't1' });
      await store.create({ tenantId: 't1' });
      await store.create({ tenantId: 't2' });

      expect(await store.listByTenant('t1')).toHaveLength(2);
      expect(await store.listByTenant('t2')).toHaveLength(1);
      expect(await store.listByTenant('t3')).toHaveLength(0);
    });

    it('无归属的会话不会出现在任何用户/租户列表里', async () => {
      await store.create();
      expect(await store.listByUser('u1')).toHaveLength(0);
      expect(await store.listByTenant('t1')).toHaveLength(0);
    });
  });
});
