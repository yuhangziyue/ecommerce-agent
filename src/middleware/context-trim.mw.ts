import { ContextManager } from '../memory/context-manager.js';
import type { AgentMiddleware } from '../core/pipeline.js';

/**
 * 每次调用模型前裁剪历史消息，控制 input token 增长。
 *
 * 用 `trimSafely` 而非 `trimMessages`：后者盲切会把 tool_use 与 tool_result 切散，
 * 导致 Anthropic API 拒绝请求。
 *
 * 就地写回 `ctx.messages`（而不是返回新数组）—— 这个钩子的产物要被本次模型调用直接使用。
 */
export function createContextTrimMiddleware(
  manager: ContextManager = new ContextManager()
): AgentMiddleware {
  return {
    name: 'context-trim',
    beforeModel(ctx) {
      ctx.messages = manager.trimSafely(ctx.messages);
      return { action: 'continue' };
    },
  };
}
