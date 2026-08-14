import type { BudgetGuard } from '../guardrails/budget-guard.js';
import type { AgentMiddleware } from '../core/pipeline.js';

/**
 * 每次调用模型前检查 token 预算。
 *
 * 三档行为：
 * - 用尽（≥100%）→ block，本轮不再调用模型
 * - 达预警线（默认 80%）→ 放行，但通过 onWarn 回调提醒一次
 * - 其余 → 静默放行
 *
 * 预警只回调一次：这个钩子在一轮内可能被触发多次（每次工具调用后都要再问模型），
 * 每次都刷一条预警会把终端/日志淹掉。
 */
export function createBudgetGuardMiddleware(
  guard: BudgetGuard,
  onWarn?: (warning: string) => void
): AgentMiddleware {
  let warned = false;

  return {
    name: 'budget-guard',
    beforeModel() {
      const result = guard.check();

      if (!result.allowed) {
        return {
          action: 'block',
          reason: result.warning ?? 'Token 预算已用尽，请开启新会话。',
        };
      }

      if (result.warning && !warned) {
        warned = true;
        onWarn?.(result.warning);
      }

      return { action: 'continue' };
    },
  };
}
