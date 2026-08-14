import { TokenTracker, resolvePricing } from '../src/core/token-tracker.js';
import type { TokenUsage } from '../src/core/types.js';

const MODEL = 'claude-sonnet-4-20250514';
// pricing: input=3, output=15 per 1M tokens

describe('TokenTracker', () => {
  let tracker: TokenTracker;

  beforeEach(() => {
    tracker = new TokenTracker();
  });

  describe('add()', () => {
    it('accumulates tokens and calculates cost', () => {
      const usage: TokenUsage = { inputTokens: 1000, outputTokens: 500 };
      const record = tracker.add(usage, MODEL);

      const expectedCost = (1000 * 3) / 1_000_000 + (500 * 15) / 1_000_000;
      expect(record.costUsd).toBeCloseTo(expectedCost);
      expect(record.model).toBe(MODEL);
      expect(record.usage).toEqual(usage);
      expect(record.timestamp).toBeGreaterThan(0);
    });

    it('accumulates across multiple calls', () => {
      tracker.add({ inputTokens: 1000, outputTokens: 500 }, MODEL);
      tracker.add({ inputTokens: 2000, outputTokens: 1000 }, MODEL);

      expect(tracker.getTotalTokens()).toBe(4500);
    });
  });

  describe('getTotalTokens()', () => {
    it('returns sum of input + output tokens', () => {
      tracker.add({ inputTokens: 100, outputTokens: 200 }, MODEL);
      expect(tracker.getTotalTokens()).toBe(300);
    });

    it('returns 0 when no tokens added', () => {
      expect(tracker.getTotalTokens()).toBe(0);
    });
  });

  describe('getTotalCost()', () => {
    it('returns accumulated cost across calls', () => {
      tracker.add({ inputTokens: 1_000_000, outputTokens: 0 }, MODEL);
      tracker.add({ inputTokens: 0, outputTokens: 1_000_000 }, MODEL);

      // 1M input * 3/1M + 1M output * 15/1M = 3 + 15 = 18
      expect(tracker.getTotalCost()).toBeCloseTo(18);
    });
  });

  describe('isOverBudget()', () => {
    it('returns false when under limit', () => {
      tracker.add({ inputTokens: 100, outputTokens: 100 }, MODEL);
      expect(tracker.isOverBudget(1000)).toBe(false);
    });

    it('returns true when over limit', () => {
      tracker.add({ inputTokens: 600, outputTokens: 500 }, MODEL);
      expect(tracker.isOverBudget(1000)).toBe(true);
    });

    it('returns false when exactly at limit', () => {
      tracker.add({ inputTokens: 500, outputTokens: 500 }, MODEL);
      expect(tracker.isOverBudget(1000)).toBe(false);
    });
  });

  describe('getSummary()', () => {
    it('returns all fields correctly', () => {
      tracker.add({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 100 }, MODEL);
      tracker.add({ inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 300, cacheWriteTokens: 50 }, MODEL);

      const summary = tracker.getSummary();

      expect(summary.totalInputTokens).toBe(3000);
      expect(summary.totalOutputTokens).toBe(1500);
      expect(summary.totalTokens).toBe(4500);
      expect(summary.callCount).toBe(2);
      expect(summary.cacheReadTokens).toBe(500);
      expect(summary.cacheWriteTokens).toBe(150);

      const expectedCost =
        (3000 * 3) / 1_000_000 + (1500 * 15) / 1_000_000;
      expect(summary.totalCostUsd).toBeCloseTo(expectedCost);
    });
  });

  // ============ v0.3 新增：Claude 5 系列价格 + 带生效期的定价 ============
  describe('Claude 5 系列定价', () => {
    const ONE_M = { inputTokens: 1_000_000, outputTokens: 1_000_000 };

    it('claude-opus-5 按 $5/$25 计价', () => {
      const r = tracker.add(ONE_M, 'claude-opus-5');
      expect(r.costUsd).toBeCloseTo(30); // 5 + 25
    });

    it('claude-haiku-4-5 按 $1/$5 计价', () => {
      const r = tracker.add(ONE_M, 'claude-haiku-4-5');
      expect(r.costUsd).toBeCloseTo(6);
    });

    it('claude-fable-5 按 $10/$50 计价', () => {
      const r = tracker.add(ONE_M, 'claude-fable-5');
      expect(r.costUsd).toBeCloseTo(60);
    });

    it('旧型号价格不受影响（历史会话成本仍可复算）', () => {
      const r = tracker.add(ONE_M, 'claude-sonnet-4-20250514');
      expect(r.costUsd).toBeCloseTo(18); // 3 + 15
    });

    it('未知型号回落到兜底价 $3/$15', () => {
      const r = tracker.add(ONE_M, 'some-unreleased-model');
      expect(r.costUsd).toBeCloseTo(18);
    });
  });

  describe('带生效期的定价（claude-sonnet-5 引入期）', () => {
    const ONE_M = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    const IN_INTRO = Date.parse('2026-08-20T00:00:00Z'); // 引入期内
    const INTRO_LAST_DAY = Date.parse('2026-08-31T23:00:00Z'); // 引入期最后一天
    const AFTER_INTRO = Date.parse('2026-09-01T00:00:00Z'); // 引入期结束

    it('引入期内按 $2/$10 计价', () => {
      const r = tracker.add(ONE_M, 'claude-sonnet-5', IN_INTRO);
      expect(r.costUsd).toBeCloseTo(12); // 2 + 10
    });

    it('引入期最后一天仍按引入价（区间含右端点）', () => {
      const r = tracker.add(ONE_M, 'claude-sonnet-5', INTRO_LAST_DAY);
      expect(r.costUsd).toBeCloseTo(12);
    });

    it('引入期结束后按标准价 $3/$15 计价', () => {
      const r = tracker.add(ONE_M, 'claude-sonnet-5', AFTER_INTRO);
      expect(r.costUsd).toBeCloseTo(18); // 3 + 15
    });

    it('resolvePricing 直接暴露解析结果', () => {
      expect(resolvePricing('claude-sonnet-5', IN_INTRO)).toMatchObject({
        input: 2,
        output: 10,
      });
      expect(resolvePricing('claude-sonnet-5', AFTER_INTRO)).toMatchObject({
        input: 3,
        output: 15,
      });
    });

    it('同一会话内跨引入期的两次调用各按各自时刻计价', () => {
      tracker.add(ONE_M, 'claude-sonnet-5', IN_INTRO);
      tracker.add(ONE_M, 'claude-sonnet-5', AFTER_INTRO);
      expect(tracker.getTotalCost()).toBeCloseTo(30); // 12 + 18
    });
  });

  describe('reset()', () => {
    it('clears all data', () => {
      tracker.add({ inputTokens: 5000, outputTokens: 3000 }, MODEL);
      tracker.reset();

      expect(tracker.getTotalTokens()).toBe(0);
      expect(tracker.getTotalCost()).toBe(0);

      const summary = tracker.getSummary();
      expect(summary.callCount).toBe(0);
      expect(summary.totalInputTokens).toBe(0);
      expect(summary.totalOutputTokens).toBe(0);
      expect(summary.cacheReadTokens).toBe(0);
      expect(summary.cacheWriteTokens).toBe(0);
    });
  });
});
