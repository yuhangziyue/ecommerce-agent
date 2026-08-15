import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, ToolResult } from '../core/types.js';
import { loadOrders } from '../data/loader.js';
import type { CouponCard, CouponPlan } from '../artifacts/types.js';

/**
 * 优惠券目录。真实系统从券中心拉，这里内置一份便于端到端验证。
 * `expiresAt` 刻意用固定日期而非「当前时间 +N 天」—— 否则用例会随时间漂移。
 */
interface CouponDef {
  couponId: string;
  name: string;
  threshold: number;
  discount: number;
  expiresAt: string;
}

const COUPONS: CouponDef[] = [
  { couponId: 'CP001', name: '新人无门槛券', threshold: 0, discount: 10, expiresAt: '2027-12-31' },
  { couponId: 'CP002', name: '满 200 减 30', threshold: 200, discount: 30, expiresAt: '2027-12-31' },
  { couponId: 'CP003', name: '满 500 减 80', threshold: 500, discount: 80, expiresAt: '2027-12-31' },
  { couponId: 'CP004', name: '满 100 减 15（已过期）', threshold: 100, discount: 15, expiresAt: '2025-01-01' },
];

/**
 * 计算最优券方案。
 *
 * 本项目规则：**券不可叠加**，取减免最大的一张。
 * 抽成纯函数是因为这是整个工具唯一需要验算的部分 ——
 * 金额算错是客诉，而它不该被「读订单」这件事绑在一起测。
 */
export function planCoupons(
  amount: number,
  now = Date.now(),
  catalog: CouponDef[] = COUPONS
): CouponPlan {
  const coupons: CouponCard[] = catalog.map((c) => {
    const expired = new Date(c.expiresAt).getTime() < now;
    const belowThreshold = amount < c.threshold;

    let reason: string | null = null;
    if (expired) reason = `已于 ${c.expiresAt} 过期`;
    else if (belowThreshold) reason = `订单金额 ¥${amount} 未达 ¥${c.threshold} 门槛，还差 ¥${c.threshold - amount}`;

    return {
      couponId: c.couponId,
      name: c.name,
      threshold: c.threshold,
      discount: c.discount,
      expiresAt: c.expiresAt,
      applicable: reason === null,
      reason,
    };
  });

  const applicable = coupons.filter((c) => c.applicable);
  const best =
    applicable.length > 0
      ? applicable.reduce((a, b) => (b.discount > a.discount ? b : a))
      : null;

  const discountAmount = best ? Math.min(best.discount, amount) : 0;
  return {
    coupons,
    best,
    originalAmount: amount,
    discountAmount,
    // 实付不可能为负 —— 无门槛券金额大于订单额时只抵到 0
    finalAmount: Math.max(0, amount - discountAmount),
  };
}

const CouponParams = Type.Object({
  orderId: Type.Optional(
    Type.String({ description: '要匹配优惠券的订单号；不传则按 amount 计算' })
  ),
  amount: Type.Optional(
    Type.Number({ description: '订单金额（元）。传了 orderId 时以订单实际金额为准' })
  ),
});
type CouponParams = Static<typeof CouponParams>;

export const couponListTool: AgentTool<typeof CouponParams> = {
  name: 'coupon_list',
  description:
    '查询可用优惠券并给出最优使用方案与实付金额。客户问「有没有优惠」「怎么最划算」时使用。' +
    '可传订单号（按订单金额匹配）或直接传金额。',
  parameters: CouponParams,
  riskLevel: 'low',
  execute: async (params: CouponParams): Promise<ToolResult> => {
    let amount = params.amount ?? 0;

    if (params.orderId) {
      const order = loadOrders().find((o) => o.orderId === params.orderId);
      if (!order) {
        return { content: `未找到订单 ${params.orderId}，请核对订单号。`, isError: true };
      }
      amount = order.totalAmount;
    }

    if (amount <= 0) {
      return {
        content: '请提供订单号或订单金额，才能匹配可用优惠券。',
        isError: true,
      };
    }

    const plan = planCoupons(amount);
    const usable = plan.coupons.filter((c) => c.applicable);

    const lines = plan.coupons.map(
      (c) =>
        `  ${c.applicable ? '✓' : '✗'} ${c.name}（减 ¥${c.discount}）` +
        (c.reason ? ` —— ${c.reason}` : '')
    );

    return {
      content:
        `订单金额 ¥${plan.originalAmount}，共 ${plan.coupons.length} 张券，${usable.length} 张可用：\n` +
        lines.join('\n') +
        (plan.best
          ? `\n\n推荐使用「${plan.best.name}」，可减 ¥${plan.discountAmount}，实付 ¥${plan.finalAmount}。` +
            '\n（本店优惠券不可叠加使用）'
          : '\n\n当前没有可用的优惠券。'),
      artifact: { type: 'coupon_plan', data: plan },
      metadata: {
        bestCouponId: plan.best?.couponId ?? null,
        finalAmount: plan.finalAmount,
      },
    };
  },
};
