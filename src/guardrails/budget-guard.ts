import { TokenTracker } from '../core/token-tracker.js';

export interface BudgetCheckResult {
  allowed: boolean;
  warning?: string;
  utilization: number;
}

export class BudgetGuard {
  private tokenTracker: TokenTracker;
  private maxTokens: number;
  private warningThreshold: number;

  constructor(tokenTracker: TokenTracker, maxTokens: number = 100000, warningThreshold: number = 0.8) {
    this.tokenTracker = tokenTracker;
    this.maxTokens = maxTokens;
    this.warningThreshold = warningThreshold;
  }

  /** Check if operation is allowed within budget */
  check(): BudgetCheckResult {
    const totalTokens = this.tokenTracker.getTotalTokens();
    const utilization = this.maxTokens > 0 ? totalTokens / this.maxTokens : 1;

    if (utilization >= 1.0) {
      return {
        allowed: false,
        warning: `Token预算已用尽（${totalTokens}/${this.maxTokens}，${(utilization * 100).toFixed(1)}%），请结束当前会话或增加预算。`,
        utilization,
      };
    }

    if (utilization >= this.warningThreshold) {
      return {
        allowed: true,
        warning: `Token用量已达 ${(utilization * 100).toFixed(1)}%（${totalTokens}/${this.maxTokens}），请注意控制对话长度。`,
        utilization,
      };
    }

    return {
      allowed: true,
      utilization,
    };
  }
}
