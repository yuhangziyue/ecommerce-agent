import { Session } from '../src/core/session.js';
import { PgSessionStore } from '../src/store/pg-session-store.js';
import { messagesToAnthropicFormat } from '../src/core/model-provider.js';
import { openTestDb, truncateAll } from './store/helpers.js';
import type { Database, SessionStore } from '../src/store/types.js';
import type { Message, ToolCallEntry, ToolResultEntry } from '../src/core/types.js';

// v0.5：Session 从「JSONL 文件同步追加」改为「走 SessionStore 异步写入」。
// 写入必须异步 —— 假装同步（写后台队列）会丢掉「写成功才返回」的持久性保证，
// 而那恰恰是 v0.6 服务化最需要的。读取仍同步（内存缓存），Loop 每轮高频读历史。

describe('Session', () => {
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

  describe('create', () => {
    it('创建会话并带上 id', async () => {
      const session = await Session.create(store);
      expect(session.getId()).toMatch(/^session-/);
    });

    it('创建时写入一条 metadata（created）', async () => {
      const session = await Session.create(store);
      const entries = session.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('metadata');
    });

    it('可带 userId / tenantId（v0.11 计费聚合的基础）', async () => {
      const session = await Session.create(store, { userId: 'u1', tenantId: 't1' });
      expect(session.getUserId()).toBe('u1');
      expect(session.getTenantId()).toBe('t1');
    });
  });

  describe('appendMessage / getMessages', () => {
    it('写入后可读回', async () => {
      const session = await Session.create(store);
      await session.appendMessage({
        role: 'user',
        content: 'Hello',
        timestamp: Date.now(),
      });

      const messages = session.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ role: 'user', content: 'Hello' });
    });

    it('按写入顺序返回', async () => {
      const session = await Session.create(store);
      await session.appendMessage({ role: 'user', content: 'Hi', timestamp: 1 });
      await session.appendMessage({
        role: 'assistant',
        content: 'Hello!',
        timestamp: 2,
      });

      expect(session.getMessages().map((m) => m.role)).toEqual(['user', 'assistant']);
    });
  });

  describe('appendToolCall / appendToolResult', () => {
    it('tool_call 进 entries', async () => {
      const session = await Session.create(store);
      const toolCall: ToolCallEntry = {
        toolUseId: 'tc-001',
        toolName: 'order_lookup',
        input: { orderId: 'ORD-001' },
      };
      await session.appendToolCall(toolCall);

      const calls = session.getEntries().filter((e) => e.type === 'tool_call');
      expect(calls).toHaveLength(1);
      expect((calls[0].data as ToolCallEntry).toolName).toBe('order_lookup');
    });

    it('tool_result 进 entries 且保留 durationMs', async () => {
      const session = await Session.create(store);
      const toolResult: ToolResultEntry = {
        toolUseId: 'tc-001',
        result: { content: 'Order found', isError: false },
        durationMs: 42,
      };
      await session.appendToolResult(toolResult);

      const results = session.getEntries().filter((e) => e.type === 'tool_result');
      expect(results).toHaveLength(1);
      expect((results[0].data as ToolResultEntry).durationMs).toBe(42);
    });
  });

  describe('getEntries', () => {
    it('包含全部 entry 类型', async () => {
      const session = await Session.create(store);
      await session.appendMessage({ role: 'user', content: 'test', timestamp: 1 });
      await session.appendToolCall({ toolUseId: 'tc-1', toolName: 'tool', input: {} });
      await session.appendToolResult({
        toolUseId: 'tc-1',
        result: { content: 'ok' },
        durationMs: 10,
      });

      const types = session.getEntries().map((e) => e.type);
      expect(types).toEqual(
        expect.arrayContaining(['metadata', 'message', 'tool_call', 'tool_result'])
      );
    });
  });
});

// ============ 事件流投影与 restore 合法性（v0.3 的成果，v0.5 迁库后必须保持） ============

async function seedToolTurn(session: Session): Promise<void> {
  await session.appendMessage({ role: 'user', content: '查订单和商品', timestamp: 1 });
  await session.appendMessage({
    role: 'assistant',
    content: '我来查',
    toolUses: [
      { id: 'tu_1', name: 'order_lookup', input: { orderId: 'A' } },
      { id: 'tu_2', name: 'product_search', input: { keyword: 'B' } },
    ],
    timestamp: 2,
  });
  await session.appendToolCall({ toolUseId: 'tu_1', toolName: 'order_lookup', input: {} });
  await session.appendToolResult({
    toolUseId: 'tu_1',
    result: { content: '订单已发货' },
    durationMs: 5,
  });
  await session.appendToolCall({ toolUseId: 'tu_2', toolName: 'product_search', input: {} });
  await session.appendToolResult({
    toolUseId: 'tu_2',
    result: { content: '找到 3 件商品' },
    durationMs: 7,
  });
  await session.appendMessage({ role: 'assistant', content: '都查到了', timestamp: 3 });
}

describe('Session.getMessages() 事件流投影', () => {
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

  it('把 tool_result entry 投影为 tool 角色消息（v0.3 之前整段丢失）', async () => {
    const session = await Session.create(store);
    await seedToolTurn(session);

    const messages = session.getMessages();
    expect(messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'assistant',
    ]);
    expect(messages[2].toolResult!.toolUseId).toBe('tu_1');
    expect(messages[2].content).toBe('订单已发货');
  });

  it('tool_call entry 不被重复投影（信息已在 assistant.toolUses 里）', async () => {
    const session = await Session.create(store);
    await seedToolTurn(session);
    expect(session.getMessages().filter((m) => m.role === 'tool')).toHaveLength(2);
  });

  it('metadata entry 不进对话历史', async () => {
    const session = await Session.create(store); // create 本身写了一条 metadata
    await session.appendMetadata('score', { overall: 0.8 });
    await session.appendMessage({ role: 'user', content: 'q', timestamp: 1 });

    expect(session.getMessages()).toHaveLength(1);
  });
});

describe('Session.restore() 恢复后的历史合法性', () => {
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

  it('会话不存在时返回 null（服务化后是常见路径）', async () => {
    expect(await Session.restore(store, 'no-such-session')).toBeNull();
  });

  it('每个 tool_use 都有配对的 tool_result（API 合法性不变量）', async () => {
    const original = await Session.create(store);
    await seedToolTurn(original);

    const restored = await Session.restore(store, original.getId());
    const messages = restored!.getMessages();

    const useIds = messages
      .filter((m) => m.toolUses)
      .flatMap((m) => m.toolUses!.map((t) => t.id));
    const resultIds = messages
      .filter((m) => m.role === 'tool')
      .map((m) => m.toolResult!.toolUseId);

    expect(useIds).toEqual(['tu_1', 'tu_2']);
    expect(resultIds.sort()).toEqual(useIds.sort());
  });

  it('恢复出的历史转成 API 格式后不产生孤立 tool_result', async () => {
    const original = await Session.create(store);
    await seedToolTurn(original);

    const restored = await Session.restore(store, original.getId());
    const wire = messagesToAnthropicFormat(restored!.getMessages());

    expect(wire[0]).toEqual({ role: 'user', content: '查订单和商品' });

    const toolResultGroups = wire.filter(
      (m) =>
        Array.isArray(m.content) &&
        (m.content as Array<{ type: string }>)[0]?.type === 'tool_result'
    );
    expect(toolResultGroups).toHaveLength(1);
    expect(toolResultGroups[0].content as unknown[]).toHaveLength(2);
  });

  it('恢复出的历史与运行时一致（长度相同）', async () => {
    const original = await Session.create(store);
    await seedToolTurn(original);

    const restored = await Session.restore(store, original.getId());
    expect(restored!.getMessages()).toHaveLength(original.getMessages().length);
  });

  it('跨实例恢复：另一个 store 实例也能读到（不依赖进程内状态）', async () => {
    const original = await Session.create(store, { userId: 'u1' });
    await original.appendMessage({ role: 'user', content: '持久化了吗', timestamp: 1 });

    const otherStore = new PgSessionStore(db);
    const restored = await Session.restore(otherStore, original.getId());

    expect(restored!.getUserId()).toBe('u1');
    expect(restored!.getMessages()[0].content).toBe('持久化了吗');
  });
});
