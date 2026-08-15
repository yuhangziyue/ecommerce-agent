import { buildApp } from '../../src/server/app.js';
import { openTestDb, truncateAll, makeTestStores } from '../store/helpers.js';
import { judgeLogistics } from '../../src/tools/logistics-check.js';
import { loadOrders } from '../../src/data/loader.js';
import type { Database } from '../../src/store/types.js';
import type { Stores } from '../../src/store/index.js';
import type {
  AgentConfig,
  AgentTool,
  ChatProvider,
  ChatResponse,
} from '../../src/core/types.js';
import type { FastifyInstance } from 'fastify';

const usage = { inputTokens: 10, outputTokens: 5 };

class ToolProvider implements ChatProvider {
  lastToolResults: string[] = [];
  private n = 0;

  constructor(
    public toolName: string,
    public input: Record<string, unknown>
  ) {}

  async chat(system: string, messages: any[], _t: AgentTool[]): Promise<ChatResponse> {
    if (system.includes('意图识别模块')) {
      return { content: '无法判断', toolUses: [], usage, stopReason: 'end_turn' };
    }
    const last = messages[messages.length - 1];
    if (last?.role === 'tool') {
      this.lastToolResults.push(last.content);
      return { content: '好的', toolUses: [], usage, stopReason: 'end_turn' };
    }
    this.n++;
    return {
      content: '',
      toolUses: [{ id: `t${this.n}`, name: this.toolName, input: this.input }],
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

/** 找一个符合条件的样例订单，避免把断言绑死在具体订单号上 */
function orderWithStatus(status: string): string {
  const o = loadOrders().find((x) => x.status === status);
  if (!o) throw new Error(`样例数据里没有状态为 ${status} 的订单`);
  return o.orderId;
}

describe('退货退款流 · 端到端', () => {
  let db: Database;
  let stores: Stores;
  let app: FastifyInstance;
  let provider: ToolProvider;

  beforeAll(async () => {
    db = await openTestDb();
  });
  afterAll(async () => db.close());
  beforeEach(async () => {
    await truncateAll(db);
    stores = await makeTestStores(db);
  });
  afterEach(async () => app?.close());

  /** 起一个已确认的退货请求：第一轮生成确认单 → 批准 → 第二轮执行 */
  async function runReturn(orderId: string, reason = '商品有质量问题', policy?: any) {
    provider = new ToolProvider('return_request', { orderId, reason });
    app = await buildApp({ stores, config, provider, returnPolicy: policy });

    const first = JSON.parse(
      (await app.inject({
        method: 'POST',
        url: '/v1/chat/sync',
        payload: { message: '我要退货' },
      })).body
    );

    const list = JSON.parse(
      (await app.inject({
        method: 'GET',
        url: `/v1/sessions/${first.session_id}/confirmations`,
      })).body
    ).confirmations;

    await app.inject({
      method: 'POST',
      url: `/v1/confirmations/${list[0].confirmation_id}`,
      payload: { approved: true },
    });

    await app.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '已确认', session_id: first.session_id },
    });

    return {
      sessionId: first.session_id,
      result: provider.lastToolResults[provider.lastToolResults.length - 1],
    };
  }

  it('🔴 已发货订单能走完退货流程（样例数据里的订单都在时效外，应给出具体天数）', async () => {
    const { result } = await runReturn(orderWithStatus('shipped'));

    // 样例订单创建于 2026-08 初，早已超出 7 天时效 —— 断言的是「说清楚了」
    expect(result).toContain('天');
    expect(result).toContain('人工');
  });

  it('🔴 放宽时效后同一订单可以受理并自动批准', async () => {
    const { result } = await runReturn(orderWithStatus('shipped'), '有划痕', {
      windowDays: 3650,
      autoApproveAmount: 100_000,
    });

    expect(result).toContain('已受理');
    expect(result).toContain('审核');
  });

  it('🔴 大额订单转人工审批，理由带具体金额与门槛', async () => {
    const orderId = orderWithStatus('shipped');
    const amount = loadOrders().find((o) => o.orderId === orderId)!.totalAmount;

    const { result } = await runReturn(orderId, '不喜欢', {
      windowDays: 3650,
      autoApproveAmount: 1, // 任何金额都超门槛
    });

    expect(result).toContain(String(amount));
    expect(result).toContain('人工审批');
  });

  it('🔴 未付款订单给替代方案而不是单纯拒绝', async () => {
    const { result } = await runReturn(orderWithStatus('pending'), '不想要了', {
      windowDays: 3650,
      autoApproveAmount: 100_000,
    });
    expect(result).toContain('取消订单');
  });

  it('订单不存在时明确提示核对', async () => {
    const { result } = await runReturn('ORD-NOT-EXIST');
    expect(result).toContain('未找到');
  });

  it('🔴 流程可通过 API 查到，且流转记录完整', async () => {
    const orderId = orderWithStatus('shipped');
    await runReturn(orderId, '有划痕', { windowDays: 3650, autoApproveAmount: 100_000 });

    const { rows } = await db.query<{ id: string }>(
      'SELECT id FROM business_flows WHERE subject_id = $1',
      [orderId]
    );
    expect(rows).toHaveLength(1);

    const res = await app.inject({ method: 'GET', url: `/v1/flows/${rows[0].id}` });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.order_id).toBe(orderId);
    expect(body.state).toBe('approved');
    expect(body.state_label).toContain('已批准');
    expect(body.transitions.map((t: any) => t.to)).toEqual([
      'initiated',
      'reviewing',
      'approved',
    ]);
    // 每一步都有 actor —— 出纠纷时要能回答「谁批的」
    expect(body.transitions.every((t: any) => t.actor)).toBe(true);
  });

  it('不存在的流程 → 404', async () => {
    provider = new ToolProvider('order_lookup', { orderId: 'x' });
    app = await buildApp({ stores, config, provider });
    const res = await app.inject({ method: 'GET', url: '/v1/flows/flow_nope' });
    expect(res.statusCode).toBe(404);
  });

  it('🔴 流程状态活过 app 重建（不在模型上下文里，裁剪与重启都不影响）', async () => {
    const orderId = orderWithStatus('shipped');
    await runReturn(orderId, '有划痕', { windowDays: 3650, autoApproveAmount: 100_000 });
    await app.close();

    // 全新 app，同一个库
    app = await buildApp({
      stores,
      config,
      provider: new ToolProvider('order_lookup', {}),
    });
    const { rows } = await db.query<{ id: string }>(
      'SELECT id FROM business_flows WHERE subject_id = $1',
      [orderId]
    );
    const body = JSON.parse(
      (await app.inject({ method: 'GET', url: `/v1/flows/${rows[0].id}` })).body
    );
    expect(body.state).toBe('approved');
  });
});

describe('物流异常判定', () => {
  const base = { status: 'shipped', createTime: new Date().toISOString(), tracking: { company: '顺丰', number: 'SF1' } };
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

  it('刚发货不算异常', () => {
    expect(judgeLogistics(base).issue).toBe('none');
  });

  it('🔴 发出多日未签收判为滞留，建议里包含查件与补发', () => {
    const v = judgeLogistics({ ...base, createTime: daysAgo(9) });
    expect(v.issue).toBe('stalled');
    expect(v.daysSinceOrder).toBe(9);
    expect(v.advice).toContain('查件');
    expect(v.advice).toContain('补发');
  });

  it('🔴 已付款久未发货判为异常，且主动给出取消退款的出口', () => {
    const v = judgeLogistics({ ...base, status: 'paid', tracking: null, createTime: daysAgo(6) });
    expect(v.issue).toBe('not_shipped_too_long');
    expect(v.advice).toContain('全额退款');
  });

  it('付款后仍在备货期内不算异常', () => {
    const v = judgeLogistics({ ...base, status: 'paid', tracking: null, createTime: daysAgo(1) });
    expect(v.issue).toBe('none');
  });

  it('🔴 已发货却没有运单号 → 系统异常，明确要求不要承诺时间', () => {
    const v = judgeLogistics({ ...base, tracking: null });
    expect(v.issue).toBe('no_tracking');
    expect(v.advice).toContain('不要向客户承诺');
    expect(v.advice).toContain('人工');
  });

  it('未付款订单不判物流异常，引导支付', () => {
    const v = judgeLogistics({ ...base, status: 'pending', tracking: null, createTime: daysAgo(30) });
    expect(v.issue).toBe('none');
    expect(v.advice).toContain('支付');
  });

  it('tracking 为 undefined 与为 null 行为一致（类型声明与数据不符的历史问题）', () => {
    const withNull = judgeLogistics({ ...base, tracking: null });
    const withUndef = judgeLogistics({ ...base, tracking: undefined });
    expect(withUndef.issue).toBe(withNull.issue);
  });
});
