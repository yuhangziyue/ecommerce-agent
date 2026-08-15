import { productSearchTool } from '../../src/tools/product-search.js';
import { orderLookupTool } from '../../src/tools/order-lookup.js';
import { couponListTool, planCoupons } from '../../src/tools/coupon.js';
import { membershipInfoTool, resolveLevel } from '../../src/tools/membership.js';
import { invoiceApplyTool } from '../../src/tools/invoice.js';
import { logisticsCheckTool } from '../../src/tools/logistics-check.js';
import { loadOrders } from '../../src/data/loader.js';
import { MAX_LIST_ITEMS } from '../../src/artifacts/types.js';

const anyOrder = () => loadOrders()[0].orderId;

describe('结构化返回协议 · 商品', () => {
  it('🔴 调用方不解析自然语言就能拿到商品列表（本版的全部意义）', async () => {
    const r = await productSearchTool.execute({ category: '电子产品' });

    expect(r.artifact?.type).toBe('product_list');
    const data = (r.artifact as any).data;
    expect(data.products.length).toBeGreaterThan(0);

    // 每张卡都是结构化的 —— 价格是 number 不是「¥299」这种要再解析一次的字符串
    for (const p of data.products) {
      expect(typeof p.price).toBe('number');
      expect(typeof p.inStock).toBe('boolean');
      expect(p.productId).toMatch(/^P\d+/);
    }
  });

  it('🔴 比价：按价格升序排序，且排序在截断之前', async () => {
    const r = await productSearchTool.execute({ sortBy: 'price_asc', limit: 3 });
    const prices = (r.artifact as any).data.products.map((p: any) => p.price);

    expect(prices).toEqual([...prices].sort((a, b) => a - b));

    // 全量里最便宜的那件必须在结果里 —— 先截断再排序的话它会丢
    const cheapest = Math.min(...(await productSearchTool.execute({ limit: MAX_LIST_ITEMS }).then(
      (all) => (all.artifact as any).data.products.map((p: any) => p.price)
    )));
    expect(prices[0]).toBe(cheapest);
  });

  it('按评分排序', async () => {
    const r = await productSearchTool.execute({ sortBy: 'rating', limit: 3 });
    const ratings = (r.artifact as any).data.products.map((p: any) => p.rating);
    expect(ratings).toEqual([...ratings].sort((a, b) => b - a));
  });

  it('🔴 截断时必须置 truncated（否则调用方把前 N 条当成全部）', async () => {
    const r = await productSearchTool.execute({ category: '服饰', limit: 2 });
    const data = (r.artifact as any).data;
    expect(data.products).toHaveLength(2);
    expect(data.truncated).toBe(true);
    expect(data.total).toBeGreaterThan(2);
  });

  it('未截断时 truncated 为 false', async () => {
    const r = await productSearchTool.execute({ limit: MAX_LIST_ITEMS });
    expect((r.artifact as any).data.truncated).toBe(false);
  });

  it('🔴 条数上限封顶，传超大 limit 也不会撑爆 SSE 帧', async () => {
    const r = await productSearchTool.execute({ limit: 9999 });
    expect((r.artifact as any).data.products.length).toBeLessThanOrEqual(MAX_LIST_ITEMS);
  });

  it('无结果时不产出 artifact（空卡片不该被渲染出来）', async () => {
    const r = await productSearchTool.execute({ keyword: '不存在的东西xyz' });
    expect(r.artifact).toBeUndefined();
  });
});

describe('结构化返回协议 · 订单', () => {
  it('单个订单产出订单卡', async () => {
    const r = await orderLookupTool.execute({ orderId: anyOrder() });
    expect(r.artifact?.type).toBe('order_card');

    const data = (r.artifact as any).data;
    expect(data.orderId).toBe(anyOrder());
    expect(typeof data.totalAmount).toBe('number');
    expect(data.statusLabel).toBeTruthy();
    expect(Array.isArray(data.items)).toBe(true);
  });

  it('🔴 多个订单时不产出订单卡（类型是单数，硬塞第一条会误导调用方）', async () => {
    // 找一个能命中多单的手机尾号，避免把断言绑死在具体号码上
    const counts = new Map<string, number>();
    for (const o of loadOrders()) {
      const k = o.phone.slice(-4);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const multi = [...counts].find(([, n]) => n > 1)?.[0];
    expect(multi, '样例数据里需要有一个命中多单的尾号').toBeTruthy();

    const r = await orderLookupTool.execute({ phoneLast4: multi });
    expect(r.artifact).toBeUndefined();
  });

  it('单个匹配的尾号仍然产出订单卡', async () => {
    const counts = new Map<string, number>();
    for (const o of loadOrders()) {
      const k = o.phone.slice(-4);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const single = [...counts].find(([, n]) => n === 1)![0];

    const r = await orderLookupTool.execute({ phoneLast4: single });
    expect(r.artifact?.type).toBe('order_card');
  });
});

describe('优惠券 · 金额计算可验算', () => {
  const NOW = new Date('2026-08-15').getTime();

  it('🔴 取减免最大的一张（券不可叠加）', () => {
    const plan = planCoupons(600, NOW);
    expect(plan.best?.couponId).toBe('CP003'); // 满 500 减 80
    expect(plan.discountAmount).toBe(80);
    expect(plan.finalAmount).toBe(520);
  });

  it('🔴 未达门槛的券标为不可用，且说清还差多少', () => {
    const plan = planCoupons(150, NOW);
    const cp002 = plan.coupons.find((c) => c.couponId === 'CP002')!;
    expect(cp002.applicable).toBe(false);
    expect(cp002.reason).toContain('还差 ¥50');
  });

  it('🔴 过期券不可用，且说明过期日期', () => {
    const cp004 = planCoupons(500, NOW).coupons.find((c) => c.couponId === 'CP004')!;
    expect(cp004.applicable).toBe(false);
    expect(cp004.reason).toContain('2025-01-01');
  });

  it('小额订单只能用无门槛券', () => {
    const plan = planCoupons(50, NOW);
    expect(plan.best?.couponId).toBe('CP001');
    expect(plan.finalAmount).toBe(40);
  });

  it('🔴 实付不会为负（无门槛券金额大于订单额时只抵到 0）', () => {
    const plan = planCoupons(5, NOW);
    expect(plan.finalAmount).toBe(0);
    expect(plan.discountAmount).toBe(5); // 只抵实际金额，不是券面额 10
  });

  it('原价 + 减免 = 实付（三个数自洽）', () => {
    for (const amount of [50, 199, 200, 499, 500, 1000]) {
      const p = planCoupons(amount, NOW);
      expect(p.originalAmount - p.discountAmount).toBe(p.finalAmount);
    }
  });

  it('工具按订单号取金额并产出 artifact', async () => {
    const r = await couponListTool.execute({ orderId: anyOrder() });
    expect(r.artifact?.type).toBe('coupon_plan');
    const data = (r.artifact as any).data;
    expect(data.originalAmount).toBe(loadOrders()[0].totalAmount);
  });

  it('既不给订单号也不给金额时明确报错', async () => {
    const r = await couponListTool.execute({});
    expect(r.isError).toBe(true);
  });
});

describe('会员 · 等级边界', () => {
  it('🔴 恰好达到门槛算升级（会员体系最容易扯皮的地方）', () => {
    expect(resolveLevel(1000).def.level).toBe('silver');
    expect(resolveLevel(999).def.level).toBe('bronze');
    expect(resolveLevel(5000).def.level).toBe('gold');
    expect(resolveLevel(20000).def.level).toBe('platinum');
  });

  it('最高等级的 pointsToNextLevel 为 null 而不是 0 或负数', () => {
    expect(resolveLevel(999999).pointsToNextLevel).toBeNull();
  });

  it('距下一级的积分计算正确', () => {
    expect(resolveLevel(800).pointsToNextLevel).toBe(200);
  });

  it('🔴 同一用户每次查到的积分一致（随机数会让「刚才还是黄金」）', async () => {
    const a = await membershipInfoTool.execute({}, { sessionId: 's', userId: 'u_alice' });
    const b = await membershipInfoTool.execute({}, { sessionId: 's', userId: 'u_alice' });
    expect((a.artifact as any).data.points).toBe((b.artifact as any).data.points);
  });

  it('无用户时明确报错而不是编一个等级', async () => {
    const r = await membershipInfoTool.execute({}, { sessionId: 's' });
    expect(r.isError).toBe(true);
    expect(r.artifact).toBeUndefined();
  });

  it('等级越高权益越多', () => {
    const counts = [0, 1000, 5000, 20000].map((p) => resolveLevel(p).def.benefits.length);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
  });
});

describe('发票 · 抬头与税号校验', () => {
  const paidOrder = () => loadOrders().find((o) => o.status !== 'pending')!.orderId;

  it('个人抬头正常开具', async () => {
    const r = await invoiceApplyTool.execute({ orderId: paidOrder(), title: '张三' });
    expect(r.isError).toBeFalsy();
    expect(r.artifact?.type).toBe('invoice');
    expect((r.artifact as any).data.type).toBe('personal');
  });

  it('🔴 企业抬头缺税号被拦（缺税号的发票无法入账）', async () => {
    const r = await invoiceApplyTool.execute({
      orderId: paidOrder(),
      title: '某某科技有限公司',
    });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('纳税人识别号');
  });

  it('企业抬头带税号可开具', async () => {
    const r = await invoiceApplyTool.execute({
      orderId: paidOrder(),
      title: '某某科技有限公司',
      taxNumber: '91110000000000000X',
    });
    expect(r.isError).toBeFalsy();
    expect((r.artifact as any).data.type).toBe('company');
  });

  it('🔴 未付款订单不能开票（开了就是虚开）', async () => {
    const pending = loadOrders().find((o) => o.status === 'pending');
    if (!pending) return;
    const r = await invoiceApplyTool.execute({ orderId: pending.orderId, title: '张三' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('尚未付款');
  });

  it('空抬头被拦', async () => {
    const r = await invoiceApplyTool.execute({ orderId: paidOrder(), title: '   ' });
    expect(r.isError).toBe(true);
  });

  it('🔴 开票是高风险操作，走 v0.12 的确认流（不另起一套）', () => {
    expect(invoiceApplyTool.riskLevel).toBe('high');
  });
});

describe('物流 artifact', () => {
  it('产出物流卡且标明是否异常', async () => {
    const r = await logisticsCheckTool.execute({ orderId: anyOrder() });
    expect(r.artifact?.type).toBe('logistics');
    expect(typeof (r.artifact as any).data.hasIssue).toBe('boolean');
  });
});
