import { FlowEngine } from '../../src/flows/engine.js';
import {
  buildReturnFlow,
  RETURN_FLOW_KIND,
  DEFAULT_RETURN_POLICY,
} from '../../src/flows/return-flow.js';
import { PgFlowStore } from '../../src/store/pg-flow-store.js';
import { openTestDb, truncateAll } from '../store/helpers.js';
import type { Database } from '../../src/store/types.js';

describe('FlowEngine · 退货退款流', () => {
  let db: Database;
  let store: PgFlowStore;
  let engine: FlowEngine;

  beforeAll(async () => {
    db = await openTestDb();
    store = new PgFlowStore(db);
  });
  afterAll(async () => db.close());
  beforeEach(async () => {
    await truncateAll(db);
    engine = new FlowEngine(store, [buildReturnFlow()]);
  });

  const start = (subjectId = 'ORD-1') =>
    engine.start({ kind: RETURN_FLOW_KIND, sessionId: 'sesn_1', subjectId });

  const okPayload = {
    orderStatus: 'delivered',
    daysSinceDelivery: 2,
    amount: 150,
    reason: '质量问题',
  };

  it('起点是 initiated，并留下一条 start 流转', async () => {
    const { flow, created } = await start();
    expect(created).toBe(true);
    expect(flow.state).toBe('initiated');

    const history = await engine.history(flow.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ from: '(none)', to: 'initiated', event: 'start' });
  });

  it('🔴 同一订单不会开出第二条活跃流程（否则会产生两张退款工单）', async () => {
    const first = await start('ORD-DUP');
    const second = await start('ORD-DUP');

    expect(second.created).toBe(false);
    expect(second.flow.id).toBe(first.flow.id);
  });

  it('订单流程走完后，同一订单可以再开新流程', async () => {
    const { flow } = await start('ORD-AGAIN');
    await engine.fire(flow.id, 'reject', { reason: '客户改主意' });

    const again = await start('ORD-AGAIN');
    expect(again.created).toBe(true);
    expect(again.flow.id).not.toBe(flow.id);
  });

  it('小额订单走完全流程：initiated → reviewing → approved → completed', async () => {
    const { flow } = await start();

    const accepted = await engine.fire(flow.id, 'accept', okPayload);
    expect(accepted.ok).toBe(true);
    expect(accepted.ok && accepted.flow.state).toBe('reviewing');

    const approved = await engine.fire(flow.id, 'approve', {});
    expect(approved.ok).toBe(true);
    expect(approved.ok && approved.flow.data.approvedBy).toBe('auto');

    const done = await engine.fire(flow.id, 'complete', { refundId: 'RF-1' });
    expect(done.ok && done.flow.state).toBe('completed');
    expect(done.ok && done.flow.data.refundId).toBe('RF-1');
  });

  it('🔴 大额订单不能自动批准，且理由要说清门槛（而不是「需要审批」）', async () => {
    const { flow } = await start();
    await engine.fire(flow.id, 'accept', { ...okPayload, amount: 999 });

    const result = await engine.fire(flow.id, 'approve', {});
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('999');
    expect(!result.ok && result.reason).toContain(String(DEFAULT_RETURN_POLICY.autoApproveAmount));
    // 失败不改变状态
    expect(result.flow.state).toBe('reviewing');
  });

  it('大额订单带审批人即可通过', async () => {
    const { flow } = await start();
    await engine.fire(flow.id, 'accept', { ...okPayload, amount: 999 });

    const result = await engine.fire(flow.id, 'approve', { approvedBy: '客服主管-王' });
    expect(result.ok).toBe(true);
    expect(result.ok && result.flow.data.approvedBy).toBe('客服主管-王');
  });

  it('🔴 超出售后时效被拒，理由带具体天数（客户才知道差多少）', async () => {
    const { flow } = await start();

    const result = await engine.fire(flow.id, 'accept', {
      ...okPayload,
      daysSinceDelivery: 12,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('12 天');
    expect(!result.ok && result.reason).toContain('7 天');
    expect(!result.ok && result.reason).toContain('人工');
  });

  it('🔴 未付款订单给的是替代方案而不是单纯拒绝', async () => {
    const { flow } = await start();
    const result = await engine.fire(flow.id, 'accept', {
      ...okPayload,
      orderStatus: 'pending',
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('取消订单');
  });

  it('已退款订单不重复受理', async () => {
    const { flow } = await start();
    const result = await engine.fire(flow.id, 'accept', {
      ...okPayload,
      orderStatus: 'refunded',
    });
    expect(!result.ok && result.reason).toContain('已完成退款');
  });

  it('🔴 未经审批不能直接完成（守卫拦住非法跳转）', async () => {
    const { flow } = await start();
    await engine.fire(flow.id, 'accept', okPayload);

    const result = await engine.fire(flow.id, 'complete', { refundId: 'RF-X' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('reviewing');
  });

  it('🔴 非法事件的报错要告诉模型「当前能做什么」', async () => {
    const { flow } = await start();
    const result = await engine.fire(flow.id, 'complete', {});
    expect(!result.ok && result.reason).toContain('accept');
  });

  it('🔴 已批准但没有退款工单，不能标记完成（不开空头支票）', async () => {
    const { flow } = await start();
    await engine.fire(flow.id, 'accept', okPayload);
    await engine.fire(flow.id, 'approve', {});

    const result = await engine.fire(flow.id, 'complete', {});
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('退款工单');
  });

  it('终态不再接受任何事件', async () => {
    const { flow } = await start();
    await engine.fire(flow.id, 'reject', { reason: '不符合政策' });

    const result = await engine.fire(flow.id, 'accept', okPayload);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('终态');
  });

  it('🔴 每一次流转都留痕（谁、何时、从哪到哪）', async () => {
    const { flow } = await start();
    await engine.fire(flow.id, 'accept', okPayload, 'customer');
    await engine.fire(flow.id, 'approve', {}, 'system');
    await engine.fire(flow.id, 'complete', { refundId: 'RF-2' }, 'agent');

    const history = await engine.history(flow.id);
    expect(history.map((h) => `${h.from}→${h.to}`)).toEqual([
      '(none)→initiated',
      'initiated→reviewing',
      'reviewing→approved',
      'approved→completed',
    ]);
    expect(history.map((h) => h.actor)).toEqual([
      'system',
      'customer',
      'system',
      'agent',
    ]);
  });

  it('🔴 流程状态活过 store 实例重建（不在模型上下文里）', async () => {
    const { flow } = await start();
    await engine.fire(flow.id, 'accept', okPayload);

    const reborn = new FlowEngine(new PgFlowStore(db), [buildReturnFlow()]);
    const result = await reborn.fire(flow.id, 'approve', {});
    expect(result.ok).toBe(true);
    expect(result.ok && result.flow.state).toBe('approved');
  });

  it('availableEvents 告诉模型下一步能干什么', async () => {
    const { flow } = await start();
    expect(engine.availableEvents(flow).sort()).toEqual(['accept', 'reject']);

    const accepted = await engine.fire(flow.id, 'accept', okPayload);
    expect(engine.availableEvents((accepted as any).flow).sort()).toEqual([
      'approve',
      'cancel',
      'reject',
    ]);
  });

  it('政策可配：把门槛提到 2000 后，999 元自动批准', async () => {
    const loose = new FlowEngine(store, [
      buildReturnFlow({ windowDays: 30, autoApproveAmount: 2000 }),
    ]);
    const { flow } = await loose.start({
      kind: RETURN_FLOW_KIND,
      sessionId: 'sesn_2',
      subjectId: 'ORD-LOOSE',
    });
    await loose.fire(flow.id, 'accept', { ...okPayload, amount: 999, daysSinceDelivery: 20 });

    const result = await loose.fire(flow.id, 'approve', {});
    expect(result.ok).toBe(true);
  });
});

describe('FlowEngine · 定义校验', () => {
  it('🔴 终态有出边时装配即失败（不等线上客户走到那一步才炸）', () => {
    const store = {} as any;
    expect(
      () =>
        new FlowEngine(store, [
          {
            kind: 'bad',
            initial: 'a',
            terminal: ['done'],
            rules: [
              { from: 'a', event: 'x', to: 'done' },
              { from: 'done', event: 'y', to: 'a' },
            ],
          },
        ])
    ).toThrow('不该有出边');
  });

  it('重复注册同一流程类型会抛错', () => {
    const store = {} as any;
    const engine = new FlowEngine(store, [buildReturnFlow()]);
    expect(() => engine.register(buildReturnFlow())).toThrow('重复注册');
  });

  it('未注册的流程类型抛错', () => {
    const engine = new FlowEngine({} as any, []);
    expect(() => engine.getDefinition('nope')).toThrow('未注册');
  });
});
