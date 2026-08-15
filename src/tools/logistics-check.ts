import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, ToolResult } from '../core/types.js';
import { loadOrders } from '../data/loader.js';

const LogisticsCheckParams = Type.Object({
  orderId: Type.String({ description: '要检查物流的订单号，如 ORD-20260801-001' }),
});
type LogisticsCheckParams = Static<typeof LogisticsCheckParams>;

/** 判定为异常的停滞天数。真实系统应按线路与承运商分档，这里取一个保守值 */
const STALLED_DAYS = 5;
/** 判定为「久未发货」的天数 */
const UNSHIPPED_DAYS = 3;

export type LogisticsIssue =
  | 'none'
  | 'not_shipped_too_long'
  | 'stalled'
  | 'no_tracking'
  | 'order_not_found';

export interface LogisticsVerdict {
  issue: LogisticsIssue;
  daysSinceOrder: number;
  /** 给模型的处置建议 —— 模型据此决定说什么、要不要转人工 */
  advice: string;
}

/**
 * 物流异常判定。
 *
 * 抽成纯函数是为了能单独测 —— 判定规则是这个工具唯一有价值的部分，
 * 而它不该被「读订单数据」这件事绑在一起测。
 */
export function judgeLogistics(order: {
  status: string;
  createTime: string;
  // 注意是 `?: … | null` 两者都要：类型声明写的是可选，而样例数据里实际是 null
  tracking?: { company: string; number: string } | null;
}): LogisticsVerdict {
  const daysSinceOrder = Math.floor(
    (Date.now() - new Date(order.createTime).getTime()) / 86_400_000
  );

  if (order.status === 'pending') {
    return {
      issue: 'none',
      daysSinceOrder,
      advice: '订单尚未付款，无物流信息。请引导客户完成支付。',
    };
  }

  if (order.status === 'paid' && daysSinceOrder >= UNSHIPPED_DAYS) {
    return {
      issue: 'not_shipped_too_long',
      daysSinceOrder,
      advice:
        `订单已付款 ${daysSinceOrder} 天仍未发货，超出正常备货时间。` +
        '建议：向客户致歉并说明将催促仓库，承诺 24 小时内给出发货时间；' +
        '若客户不接受可主动提出取消订单并全额退款。',
    };
  }

  if (order.status === 'paid') {
    return {
      issue: 'none',
      daysSinceOrder,
      advice: `订单已付款 ${daysSinceOrder} 天，仍在正常备货期内（${UNSHIPPED_DAYS} 天内发货）。`,
    };
  }

  if (!order.tracking) {
    return {
      issue: 'no_tracking',
      daysSinceOrder,
      advice:
        '订单状态显示已发货但没有运单号，属于系统异常。' +
        '建议：不要向客户承诺具体时间，直接转人工核实。',
    };
  }

  if (order.status === 'shipped' && daysSinceOrder >= STALLED_DAYS) {
    return {
      issue: 'stalled',
      daysSinceOrder,
      advice:
        `包裹发出 ${daysSinceOrder} 天仍未签收，可能滞留。` +
        '建议：向客户致歉，说明将联系承运商查件，24 小时内回复；' +
        '若查实丢件则按丢件流程补发或全额退款。',
    };
  }

  return {
    issue: 'none',
    daysSinceOrder,
    advice: '物流状态正常，按实际进度回复客户即可。',
  };
}

export const logisticsCheckTool: AgentTool<typeof LogisticsCheckParams> = {
  name: 'logistics_check',
  description:
    '检查订单物流是否存在异常（久未发货、包裹滞留、缺失运单号），并给出处置建议。' +
    '客户抱怨「怎么还没到」「物流不动了」时使用。',
  parameters: LogisticsCheckParams,
  riskLevel: 'low',
  execute: async (params: LogisticsCheckParams): Promise<ToolResult> => {
    const order = loadOrders().find((o) => o.orderId === params.orderId);
    if (!order) {
      return {
        content: `未找到订单 ${params.orderId}，请核对订单号。`,
        isError: true,
      };
    }

    const verdict = judgeLogistics(order);
    const tracking = order.tracking
      ? `${order.tracking.company} ${order.tracking.number}`
      : '（无运单号）';

    return {
      content:
        `订单 ${params.orderId} 物流检查结果：\n` +
        `下单至今: ${verdict.daysSinceOrder} 天\n` +
        `订单状态: ${order.status}\n` +
        `运单信息: ${tracking}\n` +
        `异常判定: ${verdict.issue === 'none' ? '无异常' : verdict.issue}\n` +
        `处置建议: ${verdict.advice}`,
      artifact: {
        type: 'logistics',
        data: {
          orderId: params.orderId,
          issue: verdict.issue,
          daysSinceOrder: verdict.daysSinceOrder,
          tracking: order.tracking ?? null,
          hasIssue: verdict.issue !== 'none',
        },
      },
      metadata: {
        issue: verdict.issue,
        daysSinceOrder: verdict.daysSinceOrder,
        hasTracking: Boolean(order.tracking),
      },
    };
  },
};
