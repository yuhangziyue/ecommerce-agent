import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, ToolResult } from '../core/types.js';
import { loadOrders } from '../data/loader.js';
import { getDefaultRefundStore } from './refund-store.js';

const RefundApplyParams = Type.Object({
  orderId: Type.String({ description: '要退款的订单号，如 ORD-20260801-001' }),
  reason: Type.String({ description: '退款原因，需向客户确认后填写' }),
});
type RefundApplyParams = Static<typeof RefundApplyParams>;

export const refundApplyTool: AgentTool<typeof RefundApplyParams> = {
  name: 'refund_apply',
  description:
    '为指定订单提交退款申请（高风险操作，执行前必须与客户确认订单号与退款原因）。' +
    '仅在客户明确要求退款时调用；未付款订单应引导取消而非退款。',
  parameters: RefundApplyParams,
  riskLevel: 'high',
  execute: async (params: RefundApplyParams): Promise<ToolResult> => {
    const orders = loadOrders();
    const order = orders.find((o) => o.orderId === params.orderId);

    if (!order) {
      return {
        content: `未找到订单 ${params.orderId}，无法申请退款。`,
        isError: true,
      };
    }

    // v0.2 从 index.ts 内联工具移植：模块版此前只挡 pending，
    // 已退款订单可被反复提交工单。真正的幂等（工单持久化 + 唯一约束）见 v0.3。
    if (order.status === 'refunded') {
      return {
        content: `订单 ${params.orderId} 已经退款，无需重复操作。`,
        isError: false,
      };
    }

    if (order.status === 'pending') {
      return {
        content:
          `订单 ${params.orderId} 尚未付款，无需申请退款。` +
          '如需取消订单，请使用取消订单功能。',
        isError: true,
      };
    }

    // v0.3：按订单号幂等。重复申请返回原工单，不新建、不覆盖原始退款原因
    //（审计口径以首次为准）。进程内实现，v0.5 换 PG 唯一约束。
    const { ticket, created } = await getDefaultRefundStore().createIfAbsent({
      orderId: params.orderId,
      amount: order.totalAmount,
      reason: params.reason,
    });

    const header = created
      ? '退款申请已提交。'
      : `该订单已经提交过退款申请，为您查询到原工单（未重复建单）。`;

    return {
      content:
        `${header}\n` +
        `退款工单号: ${ticket.refundId}\n` +
        `订单号: ${ticket.orderId}\n` +
        `退款金额: ¥${ticket.amount}\n` +
        `退款原因: ${ticket.reason}\n` +
        '预计 3-5 个工作日内处理完成，原路退回支付账户。',
      artifact: {
        type: 'refund_ticket',
        data: {
          refundId: ticket.refundId,
          orderId: ticket.orderId,
          amount: ticket.amount,
          reason: ticket.reason,
          duplicated: !created,
        },
      },
      metadata: {
        refundId: ticket.refundId,
        orderId: ticket.orderId,
        amount: ticket.amount,
        status: created ? 'submitted' : 'already_submitted',
        duplicated: !created,
      },
    };
  },
};
