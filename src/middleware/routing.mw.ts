import type { AgentRegistry } from '../agents/registry.js';
import type { DomainAgent } from '../agents/types.js';
import type { AgentMiddleware } from '../core/pipeline.js';
import type { IntentState } from '../intent/types.js';

export const ROUTED_AGENT_KEY = 'routed_agent';

/**
 * 多 Agent 路由中间件。
 *
 * **必须排在 `intent` 中间件之后** —— 它的输入是 `ctx.metadata.intent`。
 * 拿不到意图时走兜底 Agent（全工具），而不是报错。
 *
 * 路由是**每轮**的不是每会话的：客户可能在一次会话里从售前聊到下单再到售后。
 */
export function createRoutingMiddleware(opts: {
  agents: AgentRegistry;
  onRouted?: (agent: DomainAgent) => void;
}): AgentMiddleware {
  return {
    name: 'routing',
    beforeTurn(ctx) {
      const state = ctx.metadata.intent as IntentState | undefined;
      const agent = state
        ? opts.agents.resolve(state.intent)
        : opts.agents.fallback();

      ctx.systemAppends.push(agent.systemPrompt);
      // 空 toolNames = 全部工具（兜底 Agent），此时不设置白名单
      if (agent.toolNames.length > 0) {
        ctx.allowedTools = agent.toolNames;
      }
      ctx.metadata[ROUTED_AGENT_KEY] = agent.id;

      opts.onRouted?.(agent);
      return { action: 'continue' };
    },
  };
}
