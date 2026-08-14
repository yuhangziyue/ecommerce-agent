import { AgentTool, ToolResult } from '../core/types.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadOrders(): any[] {
  const dataPath = path.join(__dirname, '..', 'data', 'orders.json');
  return JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
}

export const refundApplyTool: AgentTool = {
  name: 'refund_apply',
  description: '申请退款，需提供订单号和退款原因',
  parameters: {
    type: 'object',
    properties: {
      orderId: { type: 'string', description: '订单号' },
      reason: { type: 'string', description: '退款原因' },
    },
    required: ['orderId', 'reason'],
  },
  riskLevel: 'high',
  execute: async (params: { orderId: string; reason: string }): Promise<ToolResult> => {
    const orders = loadOrders();
    const order = orders.find((o: any) => o.orderId === params.orderId);

    if (!order) {
      return {
        content: `未找到订单 ${params.orderId}，无法申请退款。`,
        isError: true,
      };
    }

    if (order.status === 'pending') {
      return {
        content: `订单 ${params.orderId} 尚未付款，无需申请退款。如需取消订单，请使用取消订单功能。`,
        isError: true,
      };
    }

    // Generate refund ticket number
    const refundId = `REF-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

    return {
      content: `退款申请已提交。\n退款工单号: ${refundId}\n订单号: ${params.orderId}\n退款金额: ¥${order.totalAmount}\n退款原因: ${params.reason}\n预计3-5个工作日内处理完成。`,
      metadata: {
        refundId,
        orderId: params.orderId,
        amount: order.totalAmount,
        status: 'submitted',
      },
    };
  },
};
