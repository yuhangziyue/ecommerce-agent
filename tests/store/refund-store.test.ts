import { PgRefundStore } from '../../src/store/pg-refund-store.js';
import { openTestDb, truncateAll } from './helpers.js';
import type { Database, RefundStore } from '../../src/store/types.js';

describe('PgRefundStore · 真幂等（v0.3 的进程内实现重启即失效）', () => {
  let db: Database;
  let store: RefundStore;

  beforeAll(async () => {
    db = await openTestDb();
    store = new PgRefundStore(db);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  it('首次申请建单', async () => {
    const { ticket, created } = await store.createIfAbsent({
      orderId: 'ORD-1',
      amount: 299,
      reason: '不想要了',
    });

    expect(created).toBe(true);
    expect(ticket.refundId).toMatch(/^REF-/);
    expect(ticket.orderId).toBe('ORD-1');
    expect(ticket.amount).toBe(299);
  });

  it('重复申请返回原工单，不新建，不覆盖原始原因', async () => {
    const first = await store.createIfAbsent({
      orderId: 'ORD-1',
      amount: 299,
      reason: '尺码不合适',
    });
    const second = await store.createIfAbsent({
      orderId: 'ORD-1',
      amount: 299,
      reason: '完全不同的理由',
    });

    expect(second.created).toBe(false);
    expect(second.ticket.refundId).toBe(first.ticket.refundId);
    expect(second.ticket.reason).toBe('尺码不合适'); // 审计口径以首次为准
  });

  it('🔴 并发 10 次申请同一订单只建 1 单（UNIQUE(order_id) 是真实执行者）', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.createIfAbsent({ orderId: 'ORD-RACE', amount: 100, reason: `r${i}` })
      )
    );

    const ids = new Set(results.map((r) => r.ticket.refundId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1); // 只有一个是真建的

    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM refund_tickets WHERE order_id = 'ORD-RACE'`
    );
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it('不同订单各自独立建单', async () => {
    const a = await store.createIfAbsent({ orderId: 'ORD-A', amount: 100, reason: 'x' });
    const b = await store.createIfAbsent({ orderId: 'ORD-B', amount: 200, reason: 'y' });

    expect(a.ticket.refundId).not.toBe(b.ticket.refundId);
    expect(b.ticket.amount).toBe(200);
  });

  it('findByOrderId 查得到 / 查不到', async () => {
    await store.createIfAbsent({ orderId: 'ORD-1', amount: 50, reason: 'r' });

    expect(await store.findByOrderId('ORD-1')).toMatchObject({ orderId: 'ORD-1' });
    expect(await store.findByOrderId('ORD-NONE')).toBeUndefined();
  });

  it('金额小数不丢精度（NUMERIC 而非 float）', async () => {
    const { ticket } = await store.createIfAbsent({
      orderId: 'ORD-DEC',
      amount: 1234.56,
      reason: 'r',
    });
    expect(ticket.amount).toBe(1234.56);
    expect((await store.findByOrderId('ORD-DEC'))!.amount).toBe(1234.56);
  });
});
