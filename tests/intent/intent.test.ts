import { IntentRecognizer, extractJson } from '../../src/intent/recognizer.js';
import { advance, renderIntentContext, stateFromUnknown } from '../../src/intent/state-machine.js';
import { findMissingSlots } from '../../src/intent/types.js';
import { createIntentMiddleware, readIntentState } from '../../src/middleware/intent.mw.js';
import { Session } from '../../src/core/session.js';
import { PgSessionStore } from '../../src/store/pg-session-store.js';
import { openTestDb, truncateAll } from '../store/helpers.js';
import type { Database, SessionStore } from '../../src/store/types.js';
import type { ChatProvider, ChatResponse, Message } from '../../src/core/types.js';
import type { TurnContext } from '../../src/core/pipeline.js';
import type { IntentResult, IntentState } from '../../src/intent/types.js';

const usage = { inputTokens: 5, outputTokens: 5 };

class ScriptedProvider implements ChatProvider {
  calls = 0;
  reply = '{"intent":"order_query","confidence":0.9,"slots":{"orderId":"ORD-1"}}';
  shouldThrow = false;

  async chat(): Promise<ChatResponse> {
    this.calls++;
    if (this.shouldThrow) throw new Error('模型超时');
    return { content: this.reply, toolUses: [], usage, stopReason: 'end_turn' };
  }
  getModel(): string {
    return 'fake-model';
  }
}

function ctx(userInput = '我的订单到哪了'): TurnContext {
  return {
    sessionId: 'sesn_test',
    userInput,
    messages: [],
    systemAppends: [],
    metadata: {},
  };
}

describe('extractJson · 宽松解析', () => {
  it('纯 JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('带前后缀（模型爱加解释）', () => {
    expect(extractJson('好的，结果是：{"a":1} 以上')).toEqual({ a: 1 });
  });

  it('包在 markdown 代码块里', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('嵌套对象取完整块而非第一个 }', () => {
    expect(extractJson('x {"a":{"b":2},"c":3} y')).toEqual({ a: { b: 2 }, c: 3 });
  });

  it('字符串里含大括号不会误判', () => {
    expect(extractJson('{"a":"{not json}"}')).toEqual({ a: '{not json}' });
  });

  it('无 JSON 返回 null', () => {
    expect(extractJson('完全没有花括号')).toBeNull();
  });

  it('不合法 JSON 返回 null（不抛异常）', () => {
    expect(extractJson('{"a":}')).toBeNull();
  });
});

describe('IntentRecognizer', () => {
  let provider: ScriptedProvider;
  let recognizer: IntentRecognizer;

  beforeEach(() => {
    provider = new ScriptedProvider();
    recognizer = new IntentRecognizer({ provider });
  });

  it('识别意图与槽位', async () => {
    const r = await recognizer.recognize('我的订单 ORD-1 到哪了');
    expect(r.intent).toBe('order_query');
    expect(r.confidence).toBe(0.9);
    expect(r.slots.orderId).toBe('ORD-1');
  });

  it('🔴 模型报错时降级 unknown，不抛异常', async () => {
    provider.shouldThrow = true;
    const r = await recognizer.recognize('随便');
    expect(r.intent).toBe('unknown');
  });

  it('🔴 返回非 JSON 时降级 unknown', async () => {
    provider.reply = '我觉得他想查订单';
    expect((await recognizer.recognize('x')).intent).toBe('unknown');
  });

  it('🔴 置信度低于阈值时降级 unknown（猜错比说不知道更糟）', async () => {
    provider.reply = '{"intent":"refund","confidence":0.3,"slots":{"orderId":"ORD-9"}}';
    const r = await recognizer.recognize('嗯');
    expect(r.intent).toBe('unknown');
    expect(r.slots).toEqual({}); // 低置信度的槽位也不能用
  });

  it('非法意图名降级 unknown', async () => {
    provider.reply = '{"intent":"buy_stock","confidence":0.95,"slots":{}}';
    expect((await recognizer.recognize('x')).intent).toBe('unknown');
  });

  it('过滤未知槽位名与非字符串值', async () => {
    provider.reply =
      '{"intent":"refund","confidence":0.9,"slots":{"orderId":"ORD-1","evil":"x","reason":null,"n":5}}';
    const r = await recognizer.recognize('退款');
    expect(r.slots).toEqual({ orderId: 'ORD-1' });
  });

  it('只喂最近若干轮上下文（识别每轮都跑，成本要压住）', async () => {
    const many: Message[] = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `第 ${i} 条`,
      timestamp: i,
    }));
    await recognizer.recognize('最新问题', many);
    expect(provider.calls).toBe(1); // 不因历史长而多次调用
  });
});

describe('findMissingSlots', () => {
  it('无必需槽位的意图永远不缺', () => {
    expect(findMissingSlots('product_search', {})).toEqual([]);
    expect(findMissingSlots('chitchat', {})).toEqual([]);
  });

  it('或关系：orderId 或 phoneLast4 满足其一即可', () => {
    expect(findMissingSlots('order_query', { orderId: 'ORD-1' })).toEqual([]);
    expect(findMissingSlots('order_query', { phoneLast4: '1234' })).toEqual([]);
    expect(findMissingSlots('order_query', {}).length).toBeGreaterThan(0);
  });

  it('refund 需要 orderId 或 reason 之一', () => {
    expect(findMissingSlots('refund', { orderId: 'ORD-1' })).toEqual([]);
    expect(findMissingSlots('refund', {}).length).toBeGreaterThan(0);
  });
});

describe('意图状态机', () => {
  const result = (over: Partial<IntentResult> = {}): IntentResult => ({
    intent: 'order_query',
    confidence: 0.9,
    slots: {},
    ...over,
  });

  it('首轮识别出意图但缺槽 → collecting', () => {
    const s = advance(stateFromUnknown(), result());
    expect(s.phase).toBe('collecting');
    expect(s.missing.length).toBeGreaterThan(0);
  });

  it('槽位齐 → ready', () => {
    const s = advance(stateFromUnknown(), result({ slots: { orderId: 'ORD-1' } }));
    expect(s.phase).toBe('ready');
    expect(s.missing).toEqual([]);
  });

  it('🔴 同意图延续时槽位继承（第 1 轮给单号，第 3 轮说"退了吧"）', () => {
    const first = advance(stateFromUnknown(), result({ slots: { orderId: 'ORD-1' } }));
    const second = advance(first, result({ slots: {} }));

    expect(second.slots.orderId).toBe('ORD-1');
    expect(second.phase).toBe('ready');
  });

  it('🔴 意图切换时旧槽位被清空（否则退款的单号会被带进查物流）', () => {
    const refundState = advance(
      stateFromUnknown(),
      result({ intent: 'refund', slots: { orderId: 'ORD-REFUND', reason: '不想要' } })
    );
    const switched = advance(
      refundState,
      result({ intent: 'product_search', slots: { productKeyword: '耳机' } })
    );

    expect(switched.phase).toBe('switched');
    expect(switched.slots.orderId).toBeUndefined();
    expect(switched.previousIntent).toBe('refund');
  });

  it('unknown 不覆盖正在进行的状态（保持槽位收集）', () => {
    const collecting = advance(stateFromUnknown(), result({ slots: { orderId: 'ORD-1' } }));
    const after = advance(collecting, result({ intent: 'unknown', confidence: 0.2 }));

    expect(after.intent).toBe('order_query');
    expect(after.slots.orderId).toBe('ORD-1');
  });
});

describe('renderIntentContext', () => {
  const base: IntentState = {
    intent: 'order_query',
    phase: 'collecting',
    slots: {},
    missing: ['orderId', 'phoneLast4'],
    confidence: 0.9,
  };

  it('unknown 不注入任何东西（不限制模型）', () => {
    expect(renderIntentContext({ ...base, intent: 'unknown' })).toBeNull();
  });

  it('🔴 缺槽时给的是澄清指引而不是替模型回复', () => {
    const text = renderIntentContext(base)!;
    expect(text).toContain('还缺');
    expect(text).toContain('订单号');
    // 明确要求模型自己组织语言，而不是复述
    expect(text).toContain('不要机械复述');
  });

  it('已知槽位被列出', () => {
    const text = renderIntentContext({
      ...base,
      slots: { orderId: 'ORD-1' },
      missing: [],
      phase: 'ready',
    })!;
    expect(text).toContain('ORD-1');
  });

  it('切换时提示不要带入旧话题', () => {
    const text = renderIntentContext({
      ...base,
      intent: 'product_search',
      phase: 'switched',
      previousIntent: 'refund',
      missing: [],
    })!;
    expect(text).toContain('切换');
    expect(text).toContain('申请退款');
  });

  it('投诉意图注入转人工指引', () => {
    const text = renderIntentContext({
      ...base,
      intent: 'complaint',
      missing: [],
      phase: 'ready',
    })!;
    expect(text).toContain('human_handoff');
  });
});

describe('intent 中间件 · 与 Session 协同', () => {
  let db: Database;
  let store: SessionStore;
  let provider: ScriptedProvider;

  beforeAll(async () => {
    db = await openTestDb();
    store = new PgSessionStore(db);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
    provider = new ScriptedProvider();
  });

  it('🔴 意图注入 systemAppends，不污染 userInput', async () => {
    const session = await Session.create(store);
    const mw = createIntentMiddleware({
      recognizer: new IntentRecognizer({ provider }),
      session,
    });

    const c = ctx('我的订单 ORD-1 到哪了');
    await mw.beforeTurn!(c);

    expect(c.systemAppends).toHaveLength(1);
    expect(c.systemAppends[0]).toContain('查询订单');
    expect(c.userInput).toBe('我的订单 ORD-1 到哪了');
  });

  it('🔴 状态落 session，restore 后延续（跨请求槽位继承）', async () => {
    const session = await Session.create(store);
    const mw = createIntentMiddleware({
      recognizer: new IntentRecognizer({ provider }),
      session,
    });
    await mw.beforeTurn!(ctx('我的订单 ORD-1 到哪了'));

    // 模拟下一个 HTTP 请求：从库里恢复会话
    const restored = await Session.restore(store, session.getId());
    const state = readIntentState(restored!);

    expect(state.intent).toBe('order_query');
    expect(state.slots.orderId).toBe('ORD-1');
  });

  it('unknown 不覆盖已落盘的有效状态', async () => {
    const session = await Session.create(store);
    const recognizer = new IntentRecognizer({ provider });
    const mw = createIntentMiddleware({ recognizer, session });

    await mw.beforeTurn!(ctx('我的订单 ORD-1 到哪了'));
    provider.reply = '看不懂';
    await mw.beforeTurn!(ctx('嗯嗯'));

    expect(readIntentState(session).slots.orderId).toBe('ORD-1');
  });

  it('识别结果通过 onRecognized 旁路通知（服务端据此发 SSE）', async () => {
    const session = await Session.create(store);
    const seen: IntentState[] = [];
    const mw = createIntentMiddleware({
      recognizer: new IntentRecognizer({ provider }),
      session,
      onRecognized: (s) => seen.push(s),
    });

    await mw.beforeTurn!(ctx());
    expect(seen).toHaveLength(1);
    expect(seen[0].intent).toBe('order_query');
  });

  it('识别失败时中间件不阻断本轮', async () => {
    const session = await Session.create(store);
    provider.shouldThrow = true;
    const mw = createIntentMiddleware({
      recognizer: new IntentRecognizer({ provider }),
      session,
    });

    const c = ctx();
    const result = await mw.beforeTurn!(c);

    expect(result).toEqual({ action: 'continue' });
    expect(c.systemAppends).toHaveLength(0); // unknown 不注入
  });
});
