import { AgentRegistry } from '../../src/agents/registry.js';
import { ALL_DOMAIN_AGENTS, GENERAL_AGENT } from '../../src/agents/domains.js';
import { createRoutingMiddleware, ROUTED_AGENT_KEY } from '../../src/middleware/routing.mw.js';
import { INTENT_LABELS, type Intent, type IntentState } from '../../src/intent/types.js';
import type { TurnContext } from '../../src/core/pipeline.js';
import type { DomainAgent } from '../../src/agents/types.js';

function ctx(intent?: IntentState): TurnContext {
  return {
    sessionId: 'sesn_test',
    userInput: '你好',
    messages: [],
    systemAppends: [],
    metadata: intent ? { intent } : {},
  };
}

const state = (intent: Intent): IntentState => ({
  intent,
  phase: 'ready',
  slots: {},
  missing: [],
  confidence: 0.9,
});

describe('AgentRegistry', () => {
  const registry = new AgentRegistry();

  it('按意图解析到正确的领域 Agent', () => {
    expect(registry.resolve('product_search').id).toBe('presale');
    expect(registry.resolve('order_query').id).toBe('order');
    expect(registry.resolve('logistics').id).toBe('order');
    expect(registry.resolve('refund').id).toBe('aftersale');
    expect(registry.resolve('after_sales').id).toBe('aftersale');
    expect(registry.resolve('account').id).toBe('account');
  });

  it('🔴 每个意图都有归属（不存在无人认领的意图）', () => {
    const allIntents = Object.keys(INTENT_LABELS) as Intent[];
    for (const intent of allIntents) {
      expect(registry.resolve(intent)).toBeDefined();
    }
  });

  it('unknown 与 complaint 走兜底 Agent', () => {
    expect(registry.resolve('unknown').id).toBe('general');
    expect(registry.resolve('complaint').id).toBe('general');
  });

  it('🔴 兜底 Agent 拿全部工具（识别不出来时收窄等于让它更无能）', () => {
    expect(registry.fallback().toolNames).toEqual([]);
  });

  it('🔴 一个意图被两个领域认领时注册即抛错（路由不确定必须早暴露）', () => {
    const conflicting: DomainAgent = {
      id: 'rogue',
      name: 'x',
      description: 'x',
      intents: ['refund'], // 与 aftersale 冲突
      systemPrompt: 'x',
      toolNames: [],
    };
    expect(() => new AgentRegistry([...ALL_DOMAIN_AGENTS, conflicting])).toThrow(/同时认领/);
  });

  it('getAll 返回全部注册的 Agent', () => {
    expect(registry.getAll()).toHaveLength(ALL_DOMAIN_AGENTS.length);
  });

  it('高风险工具只出现在售后领域', () => {
    const withRefund = registry
      .getAll()
      .filter((a) => a.toolNames.includes('refund_apply'));
    expect(withRefund.map((a) => a.id)).toEqual(['aftersale']);
  });
});

describe('routing 中间件', () => {
  const registry = new AgentRegistry();

  it('领域提示词进入 systemAppends', () => {
    const c = ctx(state('product_search'));
    createRoutingMiddleware({ agents: registry }).beforeTurn!(c);

    expect(c.systemAppends).toHaveLength(1);
    expect(c.systemAppends[0]).toContain('售前顾问');
  });

  it('🔴 allowedTools 被设为该领域的工具子集', () => {
    const c = ctx(state('product_search'));
    createRoutingMiddleware({ agents: registry }).beforeTurn!(c);

    expect(c.allowedTools).toEqual(['product_search', 'faq_search']);
    // 售前场景看不到高风险的退款工具
    expect(c.allowedTools).not.toContain('refund_apply');
  });

  it('售后领域能看到 refund_apply 与转人工', () => {
    const c = ctx(state('refund'));
    createRoutingMiddleware({ agents: registry }).beforeTurn!(c);

    expect(c.allowedTools).toContain('refund_apply');
    expect(c.allowedTools).toContain('human_handoff');
  });

  it('🔴 兜底 Agent 不设 allowedTools（= 不限制工具）', () => {
    const c = ctx(state('unknown'));
    createRoutingMiddleware({ agents: registry }).beforeTurn!(c);

    expect(c.allowedTools).toBeUndefined();
  });

  it('拿不到意图时走兜底而不是报错', () => {
    const c = ctx(); // metadata 里没有 intent
    const result = createRoutingMiddleware({ agents: registry }).beforeTurn!(c);

    expect(result).toEqual({ action: 'continue' });
    expect(c.metadata[ROUTED_AGENT_KEY]).toBe('general');
    expect(c.allowedTools).toBeUndefined();
  });

  it('路由结果落 metadata 并通过 onRouted 旁路通知', () => {
    const seen: string[] = [];
    const c = ctx(state('order_query'));
    createRoutingMiddleware({
      agents: registry,
      onRouted: (a) => seen.push(a.id),
    }).beforeTurn!(c);

    expect(c.metadata[ROUTED_AGENT_KEY]).toBe('order');
    expect(seen).toEqual(['order']);
  });

  it('同一会话不同轮次可路由到不同领域（路由是每轮的）', () => {
    const mw = createRoutingMiddleware({ agents: registry });

    const turn1 = ctx(state('product_search'));
    mw.beforeTurn!(turn1);
    const turn2 = ctx(state('refund'));
    mw.beforeTurn!(turn2);

    expect(turn1.metadata[ROUTED_AGENT_KEY]).toBe('presale');
    expect(turn2.metadata[ROUTED_AGENT_KEY]).toBe('aftersale');
  });
});

describe('领域 Agent 定义的一致性', () => {
  it('每个 Agent 的工具名都是真实存在的工具', async () => {
    const { buildToolRegistry } = await import('../../src/tools/index.js');
    const known = new Set(buildToolRegistry().getAll().map((t) => t.name));

    for (const agent of ALL_DOMAIN_AGENTS) {
      for (const name of agent.toolNames) {
        expect(known.has(name), `${agent.id} 引用了不存在的工具 ${name}`).toBe(true);
      }
    }
  });

  it('每个 Agent 的提示词只写本领域规则（含领域标题）', () => {
    for (const agent of ALL_DOMAIN_AGENTS) {
      expect(agent.systemPrompt).toContain('本轮领域');
    }
  });

  it('只有兜底 Agent 用空工具列表表示全集', () => {
    const empty = ALL_DOMAIN_AGENTS.filter((a) => a.toolNames.length === 0);
    expect(empty.map((a) => a.id)).toEqual([GENERAL_AGENT.id]);
  });
});
