import type { FlowDefinition, GuardResult } from './types.js';

export const RETURN_FLOW_KIND = 'return_refund';

/**
 * 售后政策参数。
 *
 * 单独抽出来是因为它们是**业务参数不是技术参数** ——
 * 运营调「自动批准门槛从 200 提到 500」不该改代码、不该发版。
 */
export interface ReturnPolicy {
  /** 售后时效（天）。签收后超过这个天数不再受理 */
  windowDays: number;
  /** 自动批准的金额上限（元）。超过则转人工审批 */
  autoApproveAmount: number;
}

export const DEFAULT_RETURN_POLICY: ReturnPolicy = {
  windowDays: 7,
  autoApproveAmount: 200,
};

/** 允许发起退货的订单状态。未付款该走取消，已退款不必再退 */
const RETURNABLE_STATUSES = new Set(['shipped', 'delivered', 'completed', 'paid']);

export function buildReturnFlow(
  policy: ReturnPolicy = DEFAULT_RETURN_POLICY
): FlowDefinition {
  /**
   * 受理守卫：把「不能退」拆成具体的、能讲给客户听的理由。
   *
   * 这里每一条 reason 都会原样传给模型、再由模型转述给客户 ——
   * 所以「不符合退货条件」这种话是不合格的，必须说清楚是哪一条、差多少。
   */
  const acceptGuard = (_flow: any, payload: Record<string, unknown>): GuardResult => {
    const status = String(payload.orderStatus ?? '');
    const daysSince = Number(payload.daysSinceDelivery ?? 0);
    const amount = Number(payload.amount ?? 0);

    if (status === 'pending') {
      return {
        ok: false,
        reason: '该订单尚未付款，无需退货退款 —— 直接取消订单即可，款项不会扣除。',
      };
    }
    if (status === 'refunded') {
      return { ok: false, reason: '该订单已完成退款，无需重复申请。' };
    }
    if (!RETURNABLE_STATUSES.has(status)) {
      return { ok: false, reason: `订单当前状态为「${status}」，暂不支持退货退款。` };
    }
    if (daysSince > policy.windowDays) {
      return {
        ok: false,
        // 给出具体天数而不是「超时了」—— 客户才知道差多少、能不能申诉
        reason:
          `该订单已签收 ${daysSince} 天，超出 ${policy.windowDays} 天售后时效，` +
          '系统无法自动受理。如有质量问题可转人工客服协助处理。',
      };
    }
    if (amount <= 0) {
      return { ok: false, reason: '订单金额异常，无法发起退款，请转人工核实。' };
    }
    return { ok: true };
  };

  return {
    kind: RETURN_FLOW_KIND,
    initial: 'initiated',
    terminal: ['completed', 'rejected', 'cancelled'],
    rules: [
      // 受理：校验订单状态与时效
      {
        from: 'initiated',
        event: 'accept',
        to: 'reviewing',
        guard: acceptGuard,
        apply: (_f, p) => ({
          orderStatus: p.orderStatus,
          amount: Number(p.amount ?? 0),
          reason: p.reason,
          daysSinceDelivery: Number(p.daysSinceDelivery ?? 0),
        }),
      },
      // 受理不通过 → 直接拒绝（守卫的理由记进 data 供追溯）
      {
        from: 'initiated',
        event: 'reject',
        to: 'rejected',
        apply: (_f, p) => ({ rejectReason: p.reason }),
      },

      // 审批通过。金额分档在这里 —— 超过门槛必须带审批人
      {
        from: 'reviewing',
        event: 'approve',
        to: 'approved',
        guard: (flow, payload): GuardResult => {
          const amount = Number(flow.data.amount ?? 0);
          if (amount > policy.autoApproveAmount && !payload.approvedBy) {
            return {
              ok: false,
              reason:
                `退款金额 ¥${amount} 超过自动批准上限 ¥${policy.autoApproveAmount}，` +
                '需人工审批后方可通过。已为您提交人工审核，1 个工作日内回复。',
            };
          }
          return { ok: true };
        },
        apply: (flow, p) => ({
          approvedBy:
            p.approvedBy ??
            (Number(flow.data.amount ?? 0) <= policy.autoApproveAmount
              ? 'auto'
              : 'unknown'),
        }),
      },
      { from: 'reviewing', event: 'reject', to: 'rejected', apply: (_f, p) => ({ rejectReason: p.reason }) },
      { from: 'reviewing', event: 'cancel', to: 'cancelled', apply: (_f, p) => ({ cancelReason: p.reason }) },

      // 完成：必须已生成退款工单，否则「完成」是空头支票
      {
        from: 'approved',
        event: 'complete',
        to: 'completed',
        guard: (_flow, payload): GuardResult =>
          payload.refundId
            ? { ok: true }
            : {
                ok: false,
                reason: '尚未生成退款工单，不能标记为完成。',
              },
        apply: (_f, p) => ({ refundId: p.refundId, completedAt: Date.now() }),
      },
      { from: 'approved', event: 'cancel', to: 'cancelled', apply: (_f, p) => ({ cancelReason: p.reason }) },
    ],
  };
}

/** 状态的中文说明，直接进模型上下文与 API 响应 */
export const RETURN_STATE_LABELS: Record<string, string> = {
  initiated: '已发起，待受理',
  reviewing: '审核中',
  approved: '已批准，待生成退款工单',
  completed: '已完成',
  rejected: '已拒绝',
  cancelled: '已取消',
};
