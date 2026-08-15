import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, ToolResult } from '../core/types.js';
import { loadOrders } from '../data/loader.js';
import type { InvoiceCard } from '../artifacts/types.js';

const InvoiceParams = Type.Object({
  orderId: Type.String({ description: '要开发票的订单号' }),
  title: Type.String({ description: '发票抬头。个人开票填客户姓名，企业开票填公司全称' }),
  taxNumber: Type.Optional(
    Type.String({ description: '纳税人识别号。企业抬头必填，个人抬头不填' })
  ),
});
type InvoiceParams = Static<typeof InvoiceParams>;

/** 未付款的订单不能开票 —— 开了就是虚开 */
const INVOICEABLE = new Set(['paid', 'shipped', 'delivered', 'completed']);

export const invoiceApplyTool: AgentTool<typeof InvoiceParams> = {
  name: 'invoice_apply',
  description:
    '为订单申请开具电子发票（高风险操作，执行前必须与客户确认抬头与税号）。' +
    '企业抬头必须提供纳税人识别号；抬头一旦开出无法修改。',
  parameters: InvoiceParams,
  // 高风险：走 v0.12 的异步确认流。抬头开错了要作废重开，客户很反感
  riskLevel: 'high',
  execute: async (params: InvoiceParams): Promise<ToolResult> => {
    const order = loadOrders().find((o) => o.orderId === params.orderId);
    if (!order) {
      return { content: `未找到订单 ${params.orderId}，请核对订单号。`, isError: true };
    }

    if (!INVOICEABLE.has(order.status)) {
      return {
        content:
          `订单 ${params.orderId} 当前状态为「${order.status}」，尚未付款不能开具发票。` +
          '请客户完成支付后再申请。',
        isError: true,
      };
    }

    const title = params.title.trim();
    if (!title) {
      return { content: '发票抬头不能为空，请向客户确认抬头后再提交。', isError: true };
    }

    // 判定企业抬头：有税号，或抬头里含公司类字样 —— 后者用于拦住「填了公司名却没给税号」
    const looksLikeCompany = /(公司|有限|集团|企业|工作室|中心|厂)/.test(title);
    const type: InvoiceCard['type'] = params.taxNumber ? 'company' : 'personal';

    if (looksLikeCompany && !params.taxNumber) {
      return {
        content:
          `抬头「${title}」看起来是企业抬头，但未提供纳税人识别号。` +
          '企业发票缺少税号无法入账，请向客户索取税号后再提交。',
        isError: true,
      };
    }

    const card: InvoiceCard = {
      invoiceId: `INV-${params.orderId.replace(/^ORD-/, '')}`,
      orderId: params.orderId,
      amount: order.totalAmount,
      title,
      taxNumber: params.taxNumber ?? null,
      type,
      status: 'issued',
    };

    return {
      content:
        `电子发票已开具。\n` +
        `发票号: ${card.invoiceId}\n` +
        `订单号: ${card.orderId}\n` +
        `开票金额: ¥${card.amount}\n` +
        `抬头: ${card.title}（${type === 'company' ? '企业' : '个人'}）\n` +
        (card.taxNumber ? `税号: ${card.taxNumber}\n` : '') +
        '发票将于 10 分钟内发送至账户绑定邮箱。',
      artifact: { type: 'invoice', data: card },
      metadata: { invoiceId: card.invoiceId, amount: card.amount },
    };
  },
};
