import type { AgentMiddleware } from '../core/pipeline.js';
import type { Session } from '../core/session.js';
import type { SummaryCompactor } from '../memory/summary-compactor.js';

/**
 * 中期记忆中间件：消息数超阈值时把最老的一段压成摘要。
 *
 * 挂在 `beforeModel` 上，**位置必须在 `context-trim` 之前** ——
 * 否则滑窗已经把老消息丢掉了，压缩拿不到要压的内容，中期记忆等于不存在。
 *
 * 摘要落 session（`appendSummary`），因此：
 * - restore 出来的会话带着摘要，不会重复压缩
 * - 摘要在事件流里可审计（能回答「这条摘要顶替了多少条原文」）
 */
export function createCompactionMiddleware(opts: {
  compactor: SummaryCompactor;
  session: Session;
}): AgentMiddleware {
  return {
    name: 'compaction',
    async beforeModel(ctx) {
      const result = await opts.compactor.compact(ctx.messages);
      // null = 不需要压缩，或压缩失败已降级（绝不因摘要失败而拒绝服务）
      if (!result) return { action: 'continue' };

      await opts.session.appendSummary({
        content: result.summary,
        compactedCount: result.compactedCount,
      });

      // 用「摘要 + 保留的近期原文」替换本次要发出的消息集。
      // 直接从 session 重新投影，保证与落盘状态一致（而不是自己拼一个内存版本）。
      ctx.messages = opts.session.getMessages();

      return { action: 'continue' };
    },
  };
}
