import { renderProfileContext } from '../store/pg-profile-store.js';
import type { AgentMiddleware } from '../core/pipeline.js';
import type { ProfileStore } from '../store/types.js';

/**
 * 长期记忆中间件：把用户画像注入本轮 system 上下文。
 *
 * 走 `ctx.systemAppends` 而不是别的通道，理由：
 * - 塞进 `userInput` 会把画像**写进会话历史**（污染记录，还会被下一轮再压缩一次）
 * - 塞进 `config.systemPrompt` 会影响**所有会话**（那是进程级配置）
 *
 * 画像读取失败降级为不注入 —— 长期记忆是增强，不该成为对话的前置依赖。
 */
export function createProfileMiddleware(opts: {
  profiles: ProfileStore;
  userId?: string | null;
}): AgentMiddleware {
  return {
    name: 'profile',
    async beforeTurn(ctx) {
      if (!opts.userId) return { action: 'continue' };

      try {
        const profile = await opts.profiles.get(opts.userId);
        const context = renderProfileContext(profile);
        if (context) ctx.systemAppends.push(context);
      } catch (err) {
        console.warn(`[profile] 读取画像失败，本轮不注入：${(err as Error).message}`);
      }

      return { action: 'continue' };
    },
  };
}
