import type { TokenUsage, CostRecord } from './types.js';

// 内置价格表 (USD per 1M tokens)
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-sonnet-4-0': { input: 3, output: 15 },
  'claude-haiku-4-20250414': { input: 0.8, output: 4 },
  'claude-opus-4-20250514': { input: 15, output: 75 },
};

// 默认价格兜底
const DEFAULT_PRICING = { input: 3, output: 15 };

export class TokenTracker {
  private records: CostRecord[] = [];
  private totalUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  add(usage: TokenUsage, model: string): CostRecord {
    this.totalUsage.inputTokens += usage.inputTokens;
    this.totalUsage.outputTokens += usage.outputTokens;
    this.totalUsage.cacheReadTokens =
      (this.totalUsage.cacheReadTokens || 0) + (usage.cacheReadTokens || 0);
    this.totalUsage.cacheWriteTokens =
      (this.totalUsage.cacheWriteTokens || 0) + (usage.cacheWriteTokens || 0);

    const pricing = MODEL_PRICING[model] || DEFAULT_PRICING;
    const costUsd =
      (usage.inputTokens * pricing.input) / 1_000_000 +
      (usage.outputTokens * pricing.output) / 1_000_000;

    const record: CostRecord = {
      usage,
      costUsd,
      model,
      timestamp: Date.now(),
    };

    this.records.push(record);
    return record;
  }

  getTotalTokens(): number {
    return this.totalUsage.inputTokens + this.totalUsage.outputTokens;
  }

  getTotalCost(): number {
    return this.records.reduce((sum, r) => sum + r.costUsd, 0);
  }

  isOverBudget(maxTokens: number): boolean {
    return this.getTotalTokens() > maxTokens;
  }

  getUsage(): TokenUsage {
    return { ...this.totalUsage };
  }

  getSummary(): {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    totalCostUsd: number;
    callCount: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  } {
    return {
      totalInputTokens: this.totalUsage.inputTokens,
      totalOutputTokens: this.totalUsage.outputTokens,
      totalTokens: this.getTotalTokens(),
      totalCostUsd: this.getTotalCost(),
      callCount: this.records.length,
      cacheReadTokens: this.totalUsage.cacheReadTokens || 0,
      cacheWriteTokens: this.totalUsage.cacheWriteTokens || 0,
    };
  }

  reset(): void {
    this.records = [];
    this.totalUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
  }
}
