import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, ToolContext, ToolResult } from '../core/types.js';
import { loadOrders } from '../data/loader.js';
import { RETURN_FLOW_KIND, RETURN_STATE_LABELS } from '../flows/return-flow.js';
import type { FlowEngine } from '../flows/engine.js';

/**
 * 流程引擎是**进程级**依赖，装配时注入一次。
 *
 * 会话号刻意不放在这里，而是每次执行从 `ToolContext` 拿 ——
 * 模块级的「当前会话」在并发下会被后来的请求覆盖，
 * 表现为甲客户的退货记到乙客户名下，且只在有并发时出现。
 */
let engine: FlowEngine | null = null;

export function setFlowEngine(e: FlowEngine | null): void {
  engine = e;
}

const ReturnRequestParams = Type.Object({
  orderId: Type.String({ description: '要退货退款的订单号，如 ORD-20260801-001' }),
  reason: Type.String({ description: '退货原因，需向客户确认后填写' }),
});
type ReturnRequestParams = Static<typeof ReturnRequestParams>;

/** 按下单时间估算已签收天数。真实系统应读物流签收时间，这里用样例数据近似 */
function daysSince(createTime: string): number {
  const ms = Date.now() - new Date(createTime).getTime();
  return Math.floor(ms / 86_400_000);
}

export const returnRequestTool: AgentTool<typeof ReturnRequestParams> = {
  name: 'return_request',
  description:
    '发起退货退款流程（高风险操作，执行前必须与客户确认订单号与退货原因）。' +
    '会自动校验订单状态与售后时效，小额自动批准、大额转人工审批。' +
    '与 refund_apply 的区别：这个走完整的退货流程并留痕，仅退款用 refund_apply。',
  parameters: ReturnRequestParams,
  riskLevel: 'high',
  execute: async (
    params: ReturnRequestParams,
    ctx?: ToolContext
  ): Promise<ToolResult> => {
    if (!engine) {
      return { content: '退货流程服务未启用，请转人工客服处理。', isError: true };
    }

    const order = loadOrders().find((o) => o.orderId === params.orderId);
    if (!order) {
      return { content: `未找到订单 ${params.orderId}，请核对订单号。`, isError: true };
    }

    const { flow, created } = await engine.start({
      kind: RETURN_FLOW_KIND,
      sessionId: ctx?.sessionId ?? '',
      subjectId: params.orderId,
    });

    if (!created && flow.state !== 'initiated') {
      // 已有在途流程 —— 报当前进度而不是重新发起
      return {
        content:
          `订单 ${params.orderId} 已有退货申请在处理中，当前状态：` +
          `${RETURN_STATE_LABELS[flow.state] ?? flow.state}。无需重复发起。`,
        metadata: { flowId: flow.id, state: flow.state, duplicated: true },
      };
    }

    const accepted = await engine.fire(
      flow.id,
      'accept',
      {
        orderStatus: order.status,
        daysSinceDelivery: daysSince(order.createTime),
        amount: order.totalAmount,
        reason: params.reason,
      },
      'customer'
    );

    if (!accepted.ok) {
      // 受理不通过时把流程也置为 rejected，避免留下一堆停在 initiated 的僵尸流程
      await engine.fire(flow.id, 'reject', { reason: accepted.reason }, 'system');
      return { content: accepted.reason, metadata: { flowId: flow.id, state: 'rejected' } };
    }

    // 尝试自动批准：金额超门槛时守卫会拒绝，理由里已说明要转人工
    const approved = await engine.fire(flow.id, 'approve', {}, 'system');
    if (!approved.ok) {
      return {
        content: approved.reason,
        metadata: {
          flowId: flow.id,
          state: approved.flow.state,
          needsManualApproval: true,
        },
      };
    }

    return {
      content:
        `退货退款申请已受理并自动通过审核。\n` +
        `订单号: ${params.orderId}\n` +
        `退款金额: ¥${order.totalAmount}\n` +
        `退货原因: ${params.reason}\n` +
        `当前状态: ${RETURN_STATE_LABELS[approved.flow.state]}\n` +
        '请将商品寄回后联系我们，收到后 3-5 个工作日完成退款。',
      metadata: {
        flowId: flow.id,
        state: approved.flow.state,
        amount: order.totalAmount,
      },
    };
  },
};

const FlowStatusParams = Type.Object({
  orderId: Type.String({ description: '要查询退货进度的订单号' }),
});
type FlowStatusParams = Static<typeof FlowStatusParams>;

export const flowStatusTool: AgentTool<typeof FlowStatusParams> = {
  name: 'flow_status',
  description: '查询某订单的退货退款流程进度与流转记录。客户问「我的退款到哪了」时使用。',
  parameters: FlowStatusParams,
  riskLevel: 'low',
  execute: async (params: FlowStatusParams, ctx?: ToolContext): Promise<ToolResult> => {
    if (!engine) {
      return { content: '退货流程服务未启用，请转人工客服查询。', isError: true };
    }

    // 先找在途的；没有再找最近一条（可能已经走完了，客户仍会问结果）
    let flow = await engine.findActive(RETURN_FLOW_KIND, params.orderId);
    if (!flow) {
      const recent = await engine.listBySession(ctx?.sessionId ?? '', 50);
      flow = recent.find((f) => f.subjectId === params.orderId) ?? null;
    }

    if (!flow) {
      return {
        content: `订单 ${params.orderId} 没有退货退款记录。如需申请，请告知退货原因。`,
      };
    }

    const history = await engine.history(flow.id);
    const steps = history
      .map((h) => `  · ${RETURN_STATE_LABELS[h.to] ?? h.to}（${h.event}，由 ${h.actor}）`)
      .join('\n');

    return {
      content:
        `订单 ${params.orderId} 的退货退款进度：\n` +
        `当前状态: ${RETURN_STATE_LABELS[flow.state] ?? flow.state}\n` +
        (flow.data.rejectReason ? `拒绝原因: ${flow.data.rejectReason}\n` : '') +
        (flow.data.refundId ? `退款工单: ${flow.data.refundId}\n` : '') +
        `流转记录:\n${steps}`,
      metadata: { flowId: flow.id, state: flow.state },
    };
  },
};
