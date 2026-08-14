import { OutputFilter } from '../guardrails/output-filter.js';
import type { AgentMiddleware } from '../core/pipeline.js';

/**
 * 输出侧脱敏：手机号 / 身份证号 / API key 在回复返回调用方之前被改写。
 *
 * 注意这里返回 `rewrite` 而非 `block` —— 敏感信息应当脱敏后继续服务，
 * 而不是把整轮回答丢掉（那对客户是可用性事故，对业务是投诉来源）。
 */
export function createOutputFilterMiddleware(
  filter: OutputFilter = new OutputFilter()
): AgentMiddleware {
  return {
    name: 'output-filter',
    afterTurn(_ctx, reply) {
      const result = filter.check(reply);
      if (result.filtered !== undefined) {
        return { action: 'rewrite', text: result.filtered };
      }
      return { action: 'continue' };
    },
  };
}
