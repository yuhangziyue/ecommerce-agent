import type { TokenUsage, CostRecord } from './types.js';

/**
 * 一段生效期内的价格（USD per 1M tokens）。
 *
 * 为什么需要日期区间而不是 `Record<string, {input, output}>`：
 * Anthropic 的部分型号有**限时引入期定价**。例如 `claude-sonnet-5` 在 2026-08-31 之前
 * 是 $2/$10，之后回到 $3/$15。硬编码任一个数字都会在某一天开始算错 ——
 * 而 v0.11 的多租户计费账本要以这张表为基础，口径一漂全线漂。
 *
 * 因此定价按「调用发生的时刻」解析，而不是按「当前时刻」。
 */
export interface PriceWindow {
  /** 生效起（含），`YYYY-MM-DD`；省略表示「自始」 */
  from?: string;
  /** 生效止（含），`YYYY-MM-DD`；省略表示「至今」 */
  until?: string;
  input: number;
  output: number;
}

/** 价格表。同一型号的多个窗口按时间先后排列，区间不应重叠。 */
const MODEL_PRICING: Record<string, PriceWindow[]> = {
  // ── 当前主力（Claude 5 系列）──
  'claude-fable-5': [{ input: 10, output: 50 }],
  'claude-opus-5': [{ input: 5, output: 25 }],
  'claude-opus-4-8': [{ input: 5, output: 25 }],
  'claude-opus-4-7': [{ input: 5, output: 25 }],
  'claude-opus-4-6': [{ input: 5, output: 25 }],
  'claude-sonnet-5': [
    // 引入期定价，2026-08-31 截止
    { until: '2026-08-31', input: 2, output: 10 },
    // 标准定价
    { from: '2026-09-01', input: 3, output: 15 },
  ],
  'claude-sonnet-4-6': [{ input: 3, output: 15 }],
  'claude-haiku-4-5': [{ input: 1, output: 5 }],

  // ── 旧型号（保留：历史会话的成本复算需要，且 token-tracker 测试依赖）──
  'claude-sonnet-4-20250514': [{ input: 3, output: 15 }],
  'claude-sonnet-4-0': [{ input: 3, output: 15 }],
  'claude-haiku-4-20250414': [{ input: 0.8, output: 4 }],
  'claude-opus-4-20250514': [{ input: 15, output: 75 }],
};

/** 未命中型号时的兜底价（按 Sonnet 标准价，宁可高估不要低估成本） */
const DEFAULT_PRICING: PriceWindow = { input: 3, output: 15 };

function toDayString(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * 解析某型号在某时刻的适用价格。
 * 导出以便单测直接断言「引入期内外拿到不同价格」。
 */
export function resolvePricing(model: string, at: number): PriceWindow {
  const windows = MODEL_PRICING[model];
  if (!windows || windows.length === 0) return DEFAULT_PRICING;

  const day = toDayString(at);
  const hit = windows.find(
    (w) => (!w.from || day >= w.from) && (!w.until || day <= w.until)
  );

  // 落在所有窗口之外（例如型号新增了未来窗口而调用发生在更早）→ 用最后一个窗口
  return hit ?? windows[windows.length - 1];
}

export class TokenTracker {
  private records: CostRecord[] = [];
  private totalUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  /**
   * @param at 调用发生的时刻（毫秒）。定价按此刻解析 —— 补算历史会话成本时传入原始时间，
   *           才能拿到当时的价格而不是今天的价格。
   */
  add(usage: TokenUsage, model: string, at: number = Date.now()): CostRecord {
    this.totalUsage.inputTokens += usage.inputTokens;
    this.totalUsage.outputTokens += usage.outputTokens;
    this.totalUsage.cacheReadTokens =
      (this.totalUsage.cacheReadTokens || 0) + (usage.cacheReadTokens || 0);
    this.totalUsage.cacheWriteTokens =
      (this.totalUsage.cacheWriteTokens || 0) + (usage.cacheWriteTokens || 0);

    const pricing = resolvePricing(model, at);
    const costUsd =
      (usage.inputTokens * pricing.input) / 1_000_000 +
      (usage.outputTokens * pricing.output) / 1_000_000;

    const record: CostRecord = {
      usage,
      costUsd,
      model,
      timestamp: at,
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
