import { SummaryCompactor } from '../../src/memory/summary-compactor.js';
import { createCompactionMiddleware } from '../../src/middleware/compaction.mw.js';
import { Session, SUMMARY_PREFIX } from '../../src/core/session.js';
import { PgSessionStore } from '../../src/store/pg-session-store.js';
import { openTestDb, truncateAll } from '../store/helpers.js';
import type { Database, SessionStore } from '../../src/store/types.js';
import type { ChatProvider, ChatResponse, Message } from '../../src/core/types.js';
import type { TurnContext } from '../../src/core/pipeline.js';

const usage = { inputTokens: 10, outputTokens: 5 };

class SummarizingProvider implements ChatProvider {
  calls = 0;
  lastTranscript = '';
  reply = '客户张三询问订单 ORD-20260801-001 的物流，已告知顺丰 SF1234567890 派送中。';
  shouldThrow = false;

  async chat(_s: string, messages: Message[]): Promise<ChatResponse> {
    this.calls++;
    this.lastTranscript = messages[0]?.content ?? '';
    if (this.shouldThrow) throw new Error('模型超时');
    return { content: this.reply, toolUses: [], usage, stopReason: 'end_turn' };
  }

  getModel(): string {
    return 'fake-model';
  }
}

function conversation(rounds: number): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < rounds; i++) {
    messages.push({ role: 'user', content: `客户问题 ${i}`, timestamp: i * 2 });
    messages.push({ role: 'assistant', content: `客服回答 ${i}`, timestamp: i * 2 + 1 });
  }
  return messages;
}

describe('SummaryCompactor', () => {
  let provider: SummarizingProvider;
  let compactor: SummaryCompactor;

  beforeEach(() => {
    provider = new SummarizingProvider();
    compactor = new SummaryCompactor({
      provider,
      model: 'fake-model',
      threshold: 10,
      keepRecent: 4,
    });
  });

  it('未超阈值时不压缩，也不调用模型', async () => {
    const result = await compactor.compact(conversation(3)); // 6 条 < 10
    expect(result).toBeNull();
    expect(provider.calls).toBe(0);
  });

  it('超阈值时压缩最老的一段', async () => {
    const messages = conversation(8); // 16 条 > 10
    const result = await compactor.compact(messages);

    expect(result).not.toBeNull();
    expect(result!.summary).toContain('ORD-20260801-001');
    expect(result!.compactedCount).toBeGreaterThan(0);
    expect(result!.compactedCount).toBeLessThan(messages.length);
  });

  it('保留最近若干条原文不压（keepRecent 生效）', async () => {
    const messages = conversation(8); // 16 条，keepRecent=4
    const result = await compactor.compact(messages);
    expect(messages.length - result!.compactedCount).toBeGreaterThanOrEqual(4);
  });

  it('切点落在用户轮次边界上（不切散 tool_use / tool_result）', async () => {
    const messages: Message[] = [
      ...conversation(6),
      {
        role: 'assistant',
        content: '',
        toolUses: [{ id: 'tu_1', name: 'order_lookup', input: {} }],
        timestamp: 100,
      },
      {
        role: 'tool',
        content: '订单已发货',
        toolResult: { toolUseId: 'tu_1', result: { content: '订单已发货' } },
        timestamp: 101,
      },
      { role: 'user', content: '谢谢', timestamp: 102 },
      { role: 'assistant', content: '不客气', timestamp: 103 },
    ];

    const result = await compactor.compact(messages);
    // 切点必须是 user 消息
    expect(messages[result!.compactedCount].role).toBe('user');
  });

  it('被压缩区的标识类信息进入 transcript（订单号不能在压缩时就丢）', async () => {
    // 订单号放在**早期**（会被压缩的那一段），而不是保留区 ——
    // 中期记忆的意义正是「被挤出窗口的事实仍然可引用」
    const messages: Message[] = [
      { role: 'user', content: '我的订单 ORD-999 到哪了', timestamp: 0 },
      { role: 'assistant', content: '正在为您查询', timestamp: 1 },
      ...conversation(7),
    ];
    await compactor.compact(messages);
    expect(provider.lastTranscript).toContain('ORD-999');
  });

  it('🔴 压缩失败时降级为不压缩（绝不因摘要失败而拒绝服务）', async () => {
    provider.shouldThrow = true;
    const result = await compactor.compact(conversation(8));
    expect(result).toBeNull(); // 不抛异常
  });

  it('模型返回空摘要时也降级为不压缩', async () => {
    provider.reply = '   ';
    const result = await compactor.compact(conversation(8));
    expect(result).toBeNull();
  });
});

describe('compaction 中间件 · 与 Session 投影协同', () => {
  let db: Database;
  let store: SessionStore;
  let provider: SummarizingProvider;

  beforeAll(async () => {
    db = await openTestDb();
    store = new PgSessionStore(db);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
    provider = new SummarizingProvider();
  });

  async function seed(session: Session, rounds: number): Promise<void> {
    for (const m of conversation(rounds)) {
      await session.appendMessage(m);
    }
  }

  function ctxFor(session: Session): TurnContext {
    return {
      sessionId: session.getId(),
      userInput: '下一个问题',
      messages: session.getMessages(),
      systemAppends: [],
      metadata: {},
    };
  }

  it('🔴 压缩后消息数下降（摘要吸收被压掉的部分，而不是追加）', async () => {
    const session = await Session.create(store);
    await seed(session, 8); // 16 条
    const before = session.getMessages().length;

    const mw = createCompactionMiddleware({
      compactor: new SummaryCompactor({
        provider,
        model: 'fake-model',
        threshold: 10,
        keepRecent: 4,
      }),
      session,
    });

    const ctx = ctxFor(session);
    await mw.beforeModel!(ctx);

    expect(ctx.messages.length).toBeLessThan(before);
    expect(ctx.messages[0].content).toContain(SUMMARY_PREFIX.trim());
    expect(ctx.messages[0].content).toContain('ORD-20260801-001');
  });

  it('摘要落 session，restore 后仍在（不会重复压缩）', async () => {
    const session = await Session.create(store);
    await seed(session, 8);

    const mw = createCompactionMiddleware({
      compactor: new SummaryCompactor({
        provider,
        model: 'fake-model',
        threshold: 10,
        keepRecent: 4,
      }),
      session,
    });
    await mw.beforeModel!(ctxFor(session));

    const restored = await Session.restore(store, session.getId());
    const messages = restored!.getMessages();

    expect(messages[0].content).toContain(SUMMARY_PREFIX.trim());
    // restore 出来的条数与压缩后一致 —— 摘要真的吸收了历史
    expect(messages.length).toBe(session.getMessages().length);
  });

  it('🔴 第二次调用不重复压缩同一段（模型只被调用一次）', async () => {
    const session = await Session.create(store);
    await seed(session, 8);

    const mw = createCompactionMiddleware({
      compactor: new SummaryCompactor({
        provider,
        model: 'fake-model',
        threshold: 10,
        keepRecent: 4,
      }),
      session,
    });

    await mw.beforeModel!(ctxFor(session));
    expect(provider.calls).toBe(1);

    // 压缩后消息数已降到阈值以下，第二次不该再压
    await mw.beforeModel!(ctxFor(session));
    expect(provider.calls).toBe(1);
  });

  it('未超阈值时中间件是空操作', async () => {
    const session = await Session.create(store);
    await seed(session, 2); // 4 条

    const mw = createCompactionMiddleware({
      compactor: new SummaryCompactor({
        provider,
        model: 'fake-model',
        threshold: 10,
        keepRecent: 4,
      }),
      session,
    });

    const ctx = ctxFor(session);
    const before = ctx.messages.length;
    const result = await mw.beforeModel!(ctx);

    expect(result).toEqual({ action: 'continue' });
    expect(ctx.messages).toHaveLength(before);
    expect(provider.calls).toBe(0);
  });

  it('压缩失败时不写入摘要，会话历史保持原样', async () => {
    const session = await Session.create(store);
    await seed(session, 8);
    provider.shouldThrow = true;

    const mw = createCompactionMiddleware({
      compactor: new SummaryCompactor({
        provider,
        model: 'fake-model',
        threshold: 10,
        keepRecent: 4,
      }),
      session,
    });

    const before = session.getMessages().length;
    const result = await mw.beforeModel!(ctxFor(session));

    expect(result).toEqual({ action: 'continue' });
    expect(session.getMessages()).toHaveLength(before);
    expect(session.getEntries().some((e) => e.type === 'summary')).toBe(false);
  });
});
