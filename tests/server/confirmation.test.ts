import { buildApp } from '../../src/server/app.js';
import { openTestDb, truncateAll, makeTestStores } from '../store/helpers.js';
import { seedKeyOn, type TestKey } from './helpers.js';
import type { Database } from '../../src/store/types.js';
import type { Stores } from '../../src/store/index.js';
import type {
  AgentConfig,
  AgentTool,
  ChatProvider,
  ChatResponse,
} from '../../src/core/types.js';
import type { FastifyInstance } from 'fastify';

/**
 * v1.1：所有端点都要凭证。这里签一把**带 admin 的**测试钥匙 ——
 * 本文件测的不是认证，用 admin 是为了让既有用例里 body 带 tenant_id 的写法继续成立
 *（代客操作，见 SPEC P16d）。认证与租户隔离本身由
 * `tests/server/auth.test.ts` 与 `tests/server/isolation.test.ts` 专门覆盖。
 */
let H: TestKey['headers'];


const usage = { inputTokens: 10, outputTokens: 5 };

/** 每轮都尝试调用退款工具，模拟模型在客户确认后重试 */
class RefundProvider implements ChatProvider {
  toolCalls = 0;
  lastToolResults: string[] = [];

  constructor(
    private readonly toolName = 'refund_apply',
    private readonly input: Record<string, unknown> = {
      orderId: 'ORD-20260801-001',
      reason: '商品有质量问题',
    }
  ) {}

  async chat(system: string, messages: any[], _t: AgentTool[]): Promise<ChatResponse> {
    if (system.includes('意图识别模块')) {
      return { content: '无法判断', toolUses: [], usage, stopReason: 'end_turn' };
    }

    // 判据必须是**最后一条**消息而不是「历史里存不存在」——
    // 第二轮的会话历史里本来就有上一轮的 tool 消息，用 find 会让模型永远不再调用工具
    const last = messages[messages.length - 1];
    if (last?.role === 'tool') {
      this.lastToolResults.push(last.content);
      return { content: '好的，我已了解情况', toolUses: [], usage, stopReason: 'end_turn' };
    }

    this.toolCalls++;
    return {
      content: '',
      toolUses: [{ id: `t${this.toolCalls}`, name: this.toolName, input: this.input }],
      usage,
      stopReason: 'tool_use',
    };
  }

  getModel(): string {
    return 'fake-model';
  }
}

const config: AgentConfig = {
  model: 'claude-sonnet-5',
  apiKey: 'test',
  maxTurns: 3,
  maxTokensPerSession: 1_000_000,
  systemPrompt: '你是客服助手',
  confirmHighRisk: true,
};

function parseSse(body: string): Array<[string, any]> {
  return body
    .split('\n\n')
    .filter((b) => b.trim())
    .map((b) => {
      const e = b.split('\n').find((l) => l.startsWith('event: '))!;
      const d = b.split('\n').find((l) => l.startsWith('data: '))!;
      return [e.slice(7), JSON.parse(d.slice(6))] as [string, any];
    });
}

describe('异步确认 · v0.6 那个「用户取消了该操作」的谎话', () => {
  let db: Database;
  let stores: Stores;
  let app: FastifyInstance;
  let provider: RefundProvider;

  beforeAll(async () => {
    db = await openTestDb();
    H = (await seedKeyOn(db, { tenantId: 't_test', scopes: ['chat', 'read', 'write', 'admin'] })).headers;
  });
  afterAll(async () => db.close());

  beforeEach(async () => {
    await truncateAll(db);
    stores = await makeTestStores(db);
    provider = new RefundProvider();
    app = await buildApp({ stores, config, provider });
  });
  afterEach(async () => app.close());

  const chat = async (message: string, sessionId?: string) => {
    const res = await app.inject({ headers: H,
      method: 'POST',
      url: '/v1/chat/sync',
      payload: sessionId ? { message, session_id: sessionId } : { message },
    });
    return JSON.parse(res.body);
  };

  it('🔴 第一轮不执行，但工具结果说的是真话（不再谎称「用户取消」）', async () => {
    await chat('我要退款');

    const result = provider.lastToolResults[0];
    expect(result).not.toContain('取消');
    expect(result).toContain('需要客户确认');
    expect(result).toContain('cfm_');
  });

  it('🔴 确认单落库且带可核对的摘要（客户点同意时只会读这个）', async () => {
    const { session_id } = await chat('我要退款');

    const res = await app.inject({ headers: H,
      method: 'GET',
      url: `/v1/sessions/${session_id}/confirmations`,
    });
    const list = JSON.parse(res.body).confirmations;

    expect(list).toHaveLength(1);
    expect(list[0].status).toBe('pending');
    expect(list[0].summary).toContain('ORD-20260801-001');
    expect(list[0].summary).toContain('质量问题');
  });

  it('🔴 端到端：确认后第二轮真正执行，退款工单确实生成', async () => {
    const first = await chat('我要退款');

    const list = JSON.parse(
      (await app.inject({ headers: H,
        method: 'GET',
        url: `/v1/sessions/${first.session_id}/confirmations`,
      })).body
    ).confirmations;

    const decide = await app.inject({ headers: H,
      method: 'POST',
      url: `/v1/confirmations/${list[0].confirmation_id}`,
      payload: { approved: true, decided_by: 'customer' },
    });
    expect(decide.statusCode).toBe(200);
    expect(JSON.parse(decide.body).status).toBe('approved');

    // 第二轮：模型再次调用，这次真正执行
    await chat('已确认，请处理', first.session_id);

    const executed = provider.lastToolResults[provider.lastToolResults.length - 1];
    expect(executed).toContain('退款工单号');
    expect(executed).toContain('ORD-20260801-001');

    // 工单确实落库了 —— 不是只在文案里说了一句
    const { rows } = await db.query('SELECT * FROM refund_tickets');
    expect(rows).toHaveLength(1);
  });

  it('🔴 客户拒绝后不执行，且模型被告知是「客户拒绝」不是别的', async () => {
    const first = await chat('我要退款');
    const list = JSON.parse(
      (await app.inject({ headers: H,
        method: 'GET',
        url: `/v1/sessions/${first.session_id}/confirmations`,
      })).body
    ).confirmations;

    await app.inject({ headers: H,
      method: 'POST',
      url: `/v1/confirmations/${list[0].confirmation_id}`,
      payload: { approved: false },
    });

    await chat('再看看', first.session_id);

    const last = provider.lastToolResults[provider.lastToolResults.length - 1];
    expect(last).toContain('拒绝');
    const { rows } = await db.query('SELECT * FROM refund_tickets');
    expect(rows).toHaveLength(0);
  });

  it('🔴 确认单不可重放（批准一次不能换两次退款）', async () => {
    const first = await chat('我要退款');
    const list = JSON.parse(
      (await app.inject({ headers: H,
        method: 'GET',
        url: `/v1/sessions/${first.session_id}/confirmations`,
      })).body
    ).confirmations;

    await app.inject({ headers: H,
      method: 'POST',
      url: `/v1/confirmations/${list[0].confirmation_id}`,
      payload: { approved: true },
    });

    await chat('已确认', first.session_id); // 执行
    await chat('再来一次', first.session_id); // 应重新要求确认

    const last = provider.lastToolResults[provider.lastToolResults.length - 1];
    expect(last).toContain('需要客户确认');

    const { rows } = await db.query('SELECT * FROM refund_tickets');
    expect(rows).toHaveLength(1); // 仍然只有一张
  });

  it('🔴 重复决策返回 409（静默接受会让「谁批的」变成糊涂账）', async () => {
    const first = await chat('我要退款');
    const list = JSON.parse(
      (await app.inject({ headers: H,
        method: 'GET',
        url: `/v1/sessions/${first.session_id}/confirmations`,
      })).body
    ).confirmations;
    const id = list[0].confirmation_id;

    const a = await app.inject({ headers: H,
      method: 'POST',
      url: `/v1/confirmations/${id}`,
      payload: { approved: true, decided_by: '甲' },
    });
    const b = await app.inject({ headers: H,
      method: 'POST',
      url: `/v1/confirmations/${id}`,
      payload: { approved: false, decided_by: '乙' },
    });

    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(409);
    expect(JSON.parse(b.body).error.code).toBe('confirmation_already_decided');
  });

  it('不存在的确认单 → 404', async () => {
    const res = await app.inject({ headers: H,
      method: 'POST',
      url: '/v1/confirmations/cfm_nope',
      payload: { approved: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it('SSE 出现 confirmation_required 事件', async () => {
    const res = await app.inject({ headers: H,
      method: 'POST',
      url: '/v1/chat',
      payload: { message: '我要退款' },
    });

    const event = parseSse(res.body).find((e) => e[0] === 'confirmation_required');
    expect(event).toBeDefined();
    expect(event![1].tool).toBe('refund_apply');
    expect(event![1].summary).toContain('ORD-20260801-001');
    expect(event![1].confirmation_id).toMatch(/^cfm_/);
  });

  it('🔴 同一轮内反复调用只生成一张确认单（客户不该收到一串「请确认」）', async () => {
    const first = await chat('我要退款');
    await chat('还是要退', first.session_id);
    await chat('真的要退', first.session_id);

    const list = JSON.parse(
      (await app.inject({ headers: H,
        method: 'GET',
        url: `/v1/sessions/${first.session_id}/confirmations`,
      })).body
    ).confirmations;

    expect(list).toHaveLength(1);
  });

  it('低风险工具不需要确认（确认只挡高风险）', async () => {
    const lowRisk = new RefundProvider('order_lookup', { orderId: 'ORD-20260801-001' });
    const app2 = await buildApp({ stores, config, provider: lowRisk });

    await app2.inject({ headers: H,
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '查订单' },
    });

    expect(lowRisk.lastToolResults[0]).not.toContain('需要客户确认');
    await app2.close();
  });
});
