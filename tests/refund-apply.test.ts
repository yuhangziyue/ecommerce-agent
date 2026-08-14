import { refundApplyTool } from '../src/tools/refund-apply.js';
import { __resetRefundStore } from '../src/tools/refund-store.js';

// 真实数据（src/data/orders.json）中的状态：
//   ORD-20260801-001 shipped   ¥299  → 可退
//   ORD-20260803-003 paid      ¥528  → 可退
//   ORD-20260802-002 pending   ¥178  → 未付款，应拒绝
//   ORD-20260807-007 refunded  ¥199  → 已退款，应拦截

interface RefundMeta {
  refundId: string;
  orderId: string;
  amount: number;
  status: string;
}

const meta = (r: { metadata?: Record<string, unknown> }): RefundMeta =>
  r.metadata as unknown as RefundMeta;

describe('refundApplyTool · 幂等性（v0.3 修复）', () => {
  beforeEach(() => __resetRefundStore());

  it('同一订单重复申请返回同一工单号，不新建', async () => {
    const first = await refundApplyTool.execute({
      orderId: 'ORD-20260801-001',
      reason: '不想要了',
    });
    const second = await refundApplyTool.execute({
      orderId: 'ORD-20260801-001',
      reason: '换个理由再提一次',
    });

    expect(meta(first).refundId).toMatch(/^REF-/);
    expect(meta(second).refundId).toBe(meta(first).refundId);
    expect(second.content).toContain('已经提交过');
    // 重复申请不是错误，是幂等命中（isError 为可选字段，成功路径不设它）
    expect(second.isError).toBeFalsy();
  });

  it('重复申请不覆盖原始退款原因（审计口径以首次为准）', async () => {
    await refundApplyTool.execute({
      orderId: 'ORD-20260801-001',
      reason: '尺码不合适',
    });
    const second = await refundApplyTool.execute({
      orderId: 'ORD-20260801-001',
      reason: '完全不同的理由',
    });

    expect(second.content).toContain('尺码不合适');
    expect(second.content).not.toContain('完全不同的理由');
  });

  it('不同订单各自独立建单', async () => {
    const a = await refundApplyTool.execute({
      orderId: 'ORD-20260801-001',
      reason: 'r1',
    });
    const b = await refundApplyTool.execute({
      orderId: 'ORD-20260803-003',
      reason: 'r2',
    });

    expect(meta(a).refundId).not.toBe(meta(b).refundId);
    expect(meta(a).amount).toBe(299);
    expect(meta(b).amount).toBe(528);
  });

  it('三次并发申请同一订单只产生一个工单（竞态保护）', async () => {
    const results = await Promise.all([
      refundApplyTool.execute({ orderId: 'ORD-20260803-003', reason: 'x' }),
      refundApplyTool.execute({ orderId: 'ORD-20260803-003', reason: 'y' }),
      refundApplyTool.execute({ orderId: 'ORD-20260803-003', reason: 'z' }),
    ]);

    const ids = new Set(results.map((r) => meta(r).refundId));
    expect(ids.size).toBe(1);
  });
});

describe('refundApplyTool · 前置校验（v0.2 行为保持）', () => {
  beforeEach(() => __resetRefundStore());

  it('订单不存在时报错', async () => {
    const r = await refundApplyTool.execute({
      orderId: 'ORD-NOT-EXIST',
      reason: 'x',
    });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('未找到订单');
  });

  it('未付款订单被拒绝并引导取消订单', async () => {
    const r = await refundApplyTool.execute({
      orderId: 'ORD-20260802-002',
      reason: 'x',
    });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('尚未付款');
  });

  it('已退款订单被拦截', async () => {
    const r = await refundApplyTool.execute({
      orderId: 'ORD-20260807-007',
      reason: 'x',
    });
    expect(r.content).toContain('已经退款');
    expect(r.isError).toBe(false);
  });

  it('已退款订单不会在 store 里留下工单', async () => {
    await refundApplyTool.execute({ orderId: 'ORD-20260807-007', reason: 'x' });
    const r = await refundApplyTool.execute({
      orderId: 'ORD-20260807-007',
      reason: 'x',
    });
    // 仍走「已退款」分支，而不是「已经提交过」
    expect(r.content).toContain('已经退款');
  });
});
