import type { AgentMiddleware } from '../core/pipeline.js';
import type { QuotaScope, QuotaService } from '../billing/quota.js';

/** 越限时挂到 `ctx.metadata` 上，供 HTTP 层决定状态码（会话 200 / 租户 429） */
export const QUOTA_SCOPE_KEY = 'quota_exceeded_scope';

/**
 * 配额中间件：取代 v0.2 的 `budget-guard`。
 *
 * 与旧版的本质差别不在规则，在**状态存在哪**：
 * 旧版读进程内 `TokenTracker`，而那个实例每个 HTTP 请求新建一次 ——
 * 所以 `maxTokensPerSession` 实际限制的是「单个请求内多轮工具调用」的用量，
 * 纯文本回复场景下计数器加一次就随请求销毁，**熔断永远不可能触发**。
 * 这一版把真相挪到账本里。
 *
 * 挂在 `beforeModel` 而非 `beforeTurn`：工具循环里一轮可能调多次模型，
 * 挂在 beforeTurn 只能拦住第一次。
 */
export function createQuotaMiddleware(opts: {
  quota: QuotaService;
  tenantId?: string | null;
  onWarn?: (warning: string) => void;
  /**
   * 越限回调。HTTP 层据此决定状态码 —— 靠解析 `reason` 文案来判断是哪一级
   * 是**不可维护的**：改一个字就悄悄退化成 200，而这类退化没有任何报错。
   */
  onExceeded?: (scope: QuotaScope, reason: string) => void;
}): AgentMiddleware {
  let warned = false;

  return {
    name: 'quota',

    async beforeModel(ctx) {
      const verdict = await opts.quota.check({
        tenantId: opts.tenantId,
        sessionId: ctx.sessionId,
      });

      if (!verdict.allowed) {
        ctx.metadata[QUOTA_SCOPE_KEY] = verdict.scope satisfies QuotaScope;
        opts.onExceeded?.(verdict.scope, verdict.reason);
        return { action: 'block', reason: verdict.reason };
      }

      // 一轮里可能调多次模型，预警只发一次 —— 否则工具循环会刷屏
      if (verdict.warning && !warned) {
        warned = true;
        opts.onWarn?.(verdict.warning);
      }
      return { action: 'continue' };
    },
  };
}
