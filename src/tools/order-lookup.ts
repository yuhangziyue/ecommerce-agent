import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, ToolResult } from '../core/types.js';
import { loadOrders, type OrderStatus } from '../data/loader.js';

const OrderLookupParams = Type.Object({
  orderId: Type.Optional(
    Type.String({ description: '订单号，格式如 ORD-20260801-001' })
  ),
  phoneLast4: Type.Optional(
    Type.String({ description: '下单手机号后 4 位，如 1234' })
  ),
});
type OrderLookupParams = Static<typeof OrderLookupParams>;

/**
 * 订单状态的中文标签。
 * v0.2 从 index.ts 的内联工具移植而来 —— 直接把 shipped/paid 这类枚举值喂给模型，
 * 模型会原样转述给客户，可读性差。
 */
const STATUS_LABEL: Record<OrderStatus, string> = {
  pending: '待付款',
  paid: '已付款，待发货',
  shipped: '已发货，运输中',
  delivered: '已签收',
  refunded: '已退款',
  cancelled: '已取消',
};

export const orderLookupTool: AgentTool<typeof OrderLookupParams> = {
  name: 'order_lookup',
  description:
    '查询订单信息（状态、商品、金额、物流单号）。当客户询问订单进度、物流去向、' +
    '下单金额或收货情况时调用。必须提供订单号或手机号后 4 位之一。',
  parameters: OrderLookupParams,
  riskLevel: 'low',
  execute: async (params: OrderLookupParams): Promise<ToolResult> => {
    const orders = loadOrders();
    let results = orders;

    if (params.orderId) {
      results = orders.filter((o) => o.orderId === params.orderId);
    } else if (params.phoneLast4) {
      results = orders.filter((o) => o.phone.endsWith(params.phoneLast4!));
    } else {
      return {
        content: '请提供订单号或手机号后 4 位进行查询。',
        isError: true,
      };
    }

    if (results.length === 0) {
      return {
        content: '未找到匹配的订单，请确认订单号或手机号是否正确。',
        isError: false,
      };
    }

    const formatted = results
      .map((o) => {
        const items = o.items
          .map((i) => `${i.name} x${i.quantity} (¥${i.price})`)
          .join('、');
        let info =
          `订单号: ${o.orderId}\n` +
          `客户: ${o.customerName}\n` +
          `商品: ${items}\n` +
          `金额: ¥${o.totalAmount}\n` +
          `状态: ${STATUS_LABEL[o.status] ?? o.status}\n` +
          `下单时间: ${o.createTime}`;
        if (o.tracking) {
          info += `\n物流: ${o.tracking.company} ${o.tracking.number}`;
        }
        return info;
      })
      .join('\n---\n');

    return {
      content: formatted,
      metadata: {
        count: results.length,
        orderIds: results.map((o) => o.orderId),
      },
    };
  },
};
