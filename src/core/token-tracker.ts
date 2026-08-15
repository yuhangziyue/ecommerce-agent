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
  /**
   * 生效起（含），`YYYY-MM-DD`；省略表示「自始」。
   * ⚠️ **边界按 UTC 日期判定**（`toISOString().slice(0,10)`）。
   * 若某型号的限时定价按厂商本地时区截止，切换当天最多有 ≤8 小时的口径差；
   * 这是显式契约，不是疏漏 —— v0.11 对账时按此口径解释差异。
   */
  from?: string;
  /** 生效止（含），`YYYY-MM-DD`；省略表示「至今」。边界同样按 UTC 日期判定。 */
  until?: string;
  input: number;
  output: number;
}

/**
 * 定价解析结果。`resolved` 让「非精确命中」可被识别 ——
 * v0.3 的实现在未命中时静默取最后一个窗口，对账时无法筛出这类记录。
 */
export type PricingResolution = PriceWindow & {
  resolved: 'exact' | 'before-first' | 'after-last' | 'unknown-model';
};

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

function nextDay(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`) + 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * 校验一个型号的价格窗口：按时间有序、无重叠、无缝隙。
 *
 * 为什么要 throw 而不是容忍：计费表的「未命中」必须是**吵**的。
 * v0.3 的注释写了「区间不应重叠」，但没有任何东西保证它 ——
 * `.find()` 取第一个匹配，手写录错成重叠时会静默取先列的那个，
 * 而计费口径一旦静默漂移，v0.11 的多租户账本就对不上账且查不出原因。
 */
export function validatePriceWindows(model: string, windows: PriceWindow[]): void {
  if (windows.length === 0) {
    throw new Error(`[pricing] ${model}: 价格窗口不能为空`);
  }

  windows.forEach((w, i) => {
    if (i > 0 && !w.from) {
      throw new Error(`[pricing] ${model}: 只有第一个窗口可以省略 from（第 ${i + 1} 个省略了）`);
    }
    if (i < windows.length - 1 && !w.until) {
      throw new Error(`[pricing] ${model}: 只有最后一个窗口可以省略 until（第 ${i + 1} 个省略了）`);
    }
    if (w.from && w.until && w.from > w.until) {
      throw new Error(`[pricing] ${model}: 第 ${i + 1} 个窗口 from(${w.from}) 晚于 until(${w.until})`);
    }
    if (i > 0) {
      const prev = windows[i - 1];
      const expected = nextDay(prev.until!);
      if (w.from! < expected) {
        throw new Error(
          `[pricing] ${model}: 第 ${i} 与第 ${i + 1} 个窗口重叠（${prev.until} → ${w.from}）`
        );
      }
      if (w.from! > expected) {
        throw new Error(
          `[pricing] ${model}: 第 ${i} 与第 ${i + 1} 个窗口之间有缝隙（${prev.until} → ${w.from}，缺 ${expected}）`
        );
      }
    }
  });
}

/**
 * 从给定窗口集解析某时刻的价格（纯函数，便于直接单测任意窗口组合）。
 *
 * v0.4 修正 v0.3 的回退方向：原实现注释说「调用发生在更早」，代码却回退到
 * `windows[windows.length - 1]`（最未来的窗口）—— 方向是反的，
 * 会用未来的价格去算历史账。现在两端分别回退，且回退可被识别。
 */
export function resolveFromWindows(
  windows: PriceWindow[],
  at: number
): PricingResolution {
  const day = toDayString(at);

  const hit = windows.find(
    (w) => (!w.from || day >= w.from) && (!w.until || day <= w.until)
  );
  if (hit) return { ...hit, resolved: 'exact' };

  // 早于所有窗口 → 用**最早**窗口；晚于所有窗口 → 用**最晚**窗口
  const first = windows[0];
  if (first.from && day < first.from) {
    return { ...first, resolved: 'before-first' };
  }
  return { ...windows[windows.length - 1], resolved: 'after-last' };
}

/** 解析某型号在某时刻的适用价格。 */
export function resolvePricing(model: string, at: number): PricingResolution {
  const windows = MODEL_PRICING[model];
  if (!windows || windows.length === 0) {
    return { ...DEFAULT_PRICING, resolved: 'unknown-model' };
  }
  return resolveFromWindows(windows, at);
}

// 模块加载即校验全表：录错的价格表不该等到某次计费才暴露
for (const [model, windows] of Object.entries(MODEL_PRICING)) {
  validatePriceWindows(model, windows);
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
      pricingResolved: pricing.resolved,
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
