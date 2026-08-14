import { InputFilter } from '../guardrails/input-filter.js';
import type { AgentMiddleware } from '../core/pipeline.js';

/**
 * 输入侧安全检查：命中提示词注入模式或空输入即拦截整轮。
 *
 * 拦截发生在调用模型**之前** —— 恶意输入不产生任何 token 消耗。
 * v0.10 会在此基础上扩充语料集、加入分级处置与审计留痕；本版只负责把已有规则通电。
 */
export function createInputFilterMiddleware(
  filter: InputFilter = new InputFilter()
): AgentMiddleware {
  return {
    name: 'input-filter',
    beforeTurn(ctx) {
      const result = filter.check(ctx.userInput);
      if (!result.passed) {
        return {
          action: 'block',
          reason: result.reason ?? '输入未通过安全检查',
        };
      }
      return { action: 'continue' };
    },
  };
}
