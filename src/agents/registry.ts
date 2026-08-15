import { ALL_DOMAIN_AGENTS, GENERAL_AGENT } from './domains.js';
import type { DomainAgent } from './types.js';
import type { Intent } from '../intent/types.js';

/**
 * 领域 Agent 注册表：按意图解析到负责的 Agent。
 *
 * 注意这是**进程内**路由 —— 物理拆分成独立服务在 v0.15。
 * 先在单进程里把边界跑通，边界稳定后再拆，否则返工成本乘以服务数。
 */
export class AgentRegistry {
  private readonly byId = new Map<string, DomainAgent>();
  private readonly byIntent = new Map<Intent, DomainAgent>();

  constructor(agents: DomainAgent[] = ALL_DOMAIN_AGENTS) {
    for (const agent of agents) {
      this.register(agent);
    }
  }

  register(agent: DomainAgent): void {
    this.byId.set(agent.id, agent);
    for (const intent of agent.intents) {
      const existing = this.byIntent.get(intent);
      if (existing && existing.id !== agent.id) {
        // 一个意图被两个领域认领 = 路由不确定，必须在注册时就炸，
        // 而不是等到某次请求随机路由到其中一个
        throw new Error(
          `[agents] 意图 "${intent}" 被 ${existing.id} 与 ${agent.id} 同时认领`
        );
      }
      this.byIntent.set(intent, agent);
    }
  }

  get(id: string): DomainAgent | undefined {
    return this.byId.get(id);
  }

  getAll(): DomainAgent[] {
    return [...this.byId.values()];
  }

  /** 未命中时返回兜底 Agent —— 路由永远有结果，不会返回 undefined */
  resolve(intent: Intent): DomainAgent {
    return this.byIntent.get(intent) ?? this.fallback();
  }

  fallback(): DomainAgent {
    return this.byId.get(GENERAL_AGENT.id) ?? GENERAL_AGENT;
  }
}
