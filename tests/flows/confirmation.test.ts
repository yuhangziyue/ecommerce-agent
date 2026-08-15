import {
  ConfirmationService,
  summarizeToolCall,
} from '../../src/flows/confirmation.js';
import { PgConfirmationStore } from '../../src/store/pg-confirmation-store.js';
import { openTestDb, truncateAll } from '../store/helpers.js';
import type { Database } from '../../src/store/types.js';

describe('ConfirmationService · 异步确认', () => {
  let db: Database;
  let service: ConfirmationService;
  let store: PgConfirmationStore;

  beforeAll(async () => {
    db = await openTestDb();
    store = new PgConfirmationStore(db);
  });
  afterAll(async () => db.close());
  beforeEach(async () => {
    await truncateAll(db);
    service = new ConfirmationService(store);
  });

  const req = (input: Record<string, unknown> = { orderId: 'ORD-1', reason: '质量问题' }) =>
    service.require({
      sessionId: 'sesn_1',
      toolName: 'refund_apply',
      toolInput: input,
      summary: summarizeToolCall('refund_apply', input),
    });

  it('首次请求生成待确认单', async () => {
    const out = await req();
    expect(out.decision).toBe('pending');
    expect(out.confirmation.status).toBe('pending');
    expect(out.confirmation.summary).toContain('ORD-1');
  });

  it('🔴 相同工具+入参复用同一张确认单（否则客户会收到一串重复的「请确认」）', async () => {
    const first = await req();
    const second = await req();
    expect(second.confirmation.id).toBe(first.confirmation.id);
  });

  it('入参不同则是不同的确认单（不同订单不能共用一次确认）', async () => {
    const a = await req({ orderId: 'ORD-1', reason: 'x' });
    const b = await req({ orderId: 'ORD-2', reason: 'x' });
    expect(b.confirmation.id).not.toBe(a.confirmation.id);
  });

  it('🔴 入参键序不影响判定（同一件事不该生成两张单）', async () => {
    const a = await req({ orderId: 'ORD-1', reason: 'x' });
    const b = await req({ reason: 'x', orderId: 'ORD-1' });
    expect(b.confirmation.id).toBe(a.confirmation.id);
  });

  it('批准后再请求 → approved，且确认单被消费', async () => {
    const { confirmation } = await req();
    await service.decide(confirmation.id, true, 'customer');

    const out = await req();
    expect(out.decision).toBe('approved');
    expect(out.confirmation.status).toBe('consumed');
  });

  it('🔴 确认单不可重放（一张批准过的单不能换两次退款）', async () => {
    const { confirmation } = await req();
    await service.decide(confirmation.id, true, 'customer');

    const first = await req();
    expect(first.decision).toBe('approved');

    // 再来一次：已消费，应重新回到 pending 而不是再次放行
    const second = await req();
    expect(second.decision).toBe('pending');
    expect(second.confirmation.id).not.toBe(confirmation.id);
  });

  it('拒绝后再请求 → rejected（不是 pending，不该反复问）', async () => {
    const { confirmation } = await req();
    await service.decide(confirmation.id, false, 'customer');

    const out = await req();
    expect(out.decision).toBe('rejected');
  });

  it('🔴 重复决策无效（并发下两个人同时点，只有一个生效）', async () => {
    const { confirmation } = await req();

    const [a, b] = await Promise.all([
      service.decide(confirmation.id, true, '甲'),
      service.decide(confirmation.id, false, '乙'),
    ]);

    const winners = [a, b].filter(Boolean);
    expect(winners).toHaveLength(1);

    const final = await service.get(confirmation.id);
    expect(final!.decidedBy).toBe(winners[0]!.decidedBy);
  });

  it('对不存在的确认单决策返回 null 而不是抛错', async () => {
    expect(await service.decide('cfm_nope', true, 'x')).toBeNull();
  });

  it('🔴 确认单跨 store 实例仍在（服务重启不丢待确认的退款）', async () => {
    const { confirmation } = await req();
    await service.decide(confirmation.id, true, 'customer');

    const reborn = new ConfirmationService(new PgConfirmationStore(db));
    const out = await reborn.require({
      sessionId: 'sesn_1',
      toolName: 'refund_apply',
      toolInput: { orderId: 'ORD-1', reason: '质量问题' },
      summary: 'x',
    });
    expect(out.decision).toBe('approved');
  });

  it('不同会话的确认单互不干扰', async () => {
    const { confirmation } = await req();
    await service.decide(confirmation.id, true, 'customer');

    const other = await service.require({
      sessionId: 'sesn_OTHER',
      toolName: 'refund_apply',
      toolInput: { orderId: 'ORD-1', reason: '质量问题' },
      summary: 'x',
    });
    expect(other.decision).toBe('pending'); // 别的会话批准的不算数
  });
});

describe('summarizeToolCall · 摘要是客户唯一会读的东西', () => {
  it('🔴 退款摘要必须带订单号与原因（不能是「执行 refund_apply」）', () => {
    const s = summarizeToolCall('refund_apply', {
      orderId: 'ORD-20260801-001',
      reason: '商品有划痕',
    });
    expect(s).toContain('ORD-20260801-001');
    expect(s).toContain('商品有划痕');
    expect(s).not.toContain('refund_apply');
  });

  it('缺字段时明确标注而不是显示 undefined', () => {
    const s = summarizeToolCall('refund_apply', {});
    expect(s).not.toContain('undefined');
    expect(s).toContain('未知');
  });

  it('未知工具有兜底摘要', () => {
    expect(summarizeToolCall('some_tool', { a: 1 })).toContain('some_tool');
  });
});

describe('确认单的并发消费（consume 的 WHERE 守卫）', () => {
  let db: Database;
  let store: PgConfirmationStore;

  beforeAll(async () => {
    db = await openTestDb();
    store = new PgConfirmationStore(db);
  });
  afterAll(async () => db.close());
  beforeEach(async () => truncateAll(db));

  /**
   * 🔴 这一组是补的：v0.12 做红绿验证时发现，拿掉 consume 的
   * `WHERE status = 'approved'` 后**一个用例都不红** ——
   * 上面那些「不可重放」用例实际测的是 findDecided 的状态过滤，
   * 而 consume 的守卫防的是**并发**重放，那条路径当时零覆盖。
   */
  it('🔴 并发消费同一张已批准的确认单，只有一个成功', async () => {
    await store.create({
      id: 'cfm_race',
      sessionId: 's1',
      toolName: 'refund_apply',
      toolInput: { orderId: 'ORD-1' },
      summary: 'x',
    });
    await store.decide('cfm_race', true, 'customer');

    const results = await Promise.all([
      store.consume('cfm_race'),
      store.consume('cfm_race'),
      store.consume('cfm_race'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('🔴 未批准的确认单不能被消费（跳过审批直接执行）', async () => {
    await store.create({
      id: 'cfm_pending',
      sessionId: 's1',
      toolName: 'refund_apply',
      toolInput: {},
      summary: 'x',
    });
    expect(await store.consume('cfm_pending')).toBeNull();
  });

  it('🔴 被拒绝的确认单不能被消费', async () => {
    await store.create({
      id: 'cfm_rej',
      sessionId: 's1',
      toolName: 'refund_apply',
      toolInput: {},
      summary: 'x',
    });
    await store.decide('cfm_rej', false, 'customer');
    expect(await store.consume('cfm_rej')).toBeNull();
  });

  it('已消费的确认单不能再消费', async () => {
    await store.create({
      id: 'cfm_twice',
      sessionId: 's1',
      toolName: 'refund_apply',
      toolInput: {},
      summary: 'x',
    });
    await store.decide('cfm_twice', true, 'customer');
    expect(await store.consume('cfm_twice')).not.toBeNull();
    expect(await store.consume('cfm_twice')).toBeNull();
  });
});
