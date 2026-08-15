import {
  TokenTracker,
  resolvePricing,
  resolveFromWindows,
  validatePriceWindows,
} from '../src/core/token-tracker.js';
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

  // ============ v0.4：承接 v0.3 评审的三项 ============
  describe('价格窗口回退方向（v0.3 的注释与代码方向相反）', () => {
    const W = [
      { from: '2026-03-01', until: '2026-05-31', input: 1, output: 2 },
      { from: '2026-06-01', until: '2026-08-31', input: 3, output: 4 },
      { from: '2026-09-01', input: 5, output: 6 },
    ];
    const at = (d: string) => Date.parse(`${d}T12:00:00Z`);

    it('命中窗口 → exact', () => {
      expect(resolveFromWindows(W, at('2026-07-01'))).toMatchObject({
        input: 3,
        resolved: 'exact',
      });
    });

    it('早于所有窗口 → 用最早窗口，标记 before-first（v0.3 会错用最未来的价格算历史账）', () => {
      expect(resolveFromWindows(W, at('2026-01-01'))).toMatchObject({
        input: 1,
        output: 2,
        resolved: 'before-first',
      });
    });

    it('晚于所有窗口 → 用最晚窗口，标记 after-last', () => {
      const closed = [{ from: '2026-03-01', until: '2026-05-31', input: 1, output: 2 }];
      expect(resolveFromWindows(closed, at('2026-12-01'))).toMatchObject({
        input: 1,
        resolved: 'after-last',
      });
    });

    it('未知型号 → unknown-model，可在对账时筛出', () => {
      expect(resolvePricing('no-such-model', Date.now()).resolved).toBe('unknown-model');
    });

    it('CostRecord 带上解析方式（非 exact 的记录应被复核）', () => {
      expect(tracker.add({ inputTokens: 1, outputTokens: 1 }, 'claude-opus-5').pricingResolved).toBe('exact');
      expect(tracker.add({ inputTokens: 1, outputTokens: 1 }, 'no-such-model').pricingResolved).toBe('unknown-model');
    });
  });

  describe('价格窗口一致性校验（v0.3 只有注释约束，无人执行）', () => {
    it('合法窗口通过', () => {
      expect(() =>
        validatePriceWindows('m', [
          { until: '2026-08-31', input: 2, output: 10 },
          { from: '2026-09-01', input: 3, output: 15 },
        ])
      ).not.toThrow();
    });

    it('重叠窗口抛错（录错必须是吵的，不能静默取先列的那个）', () => {
      expect(() =>
        validatePriceWindows('m', [
          { until: '2026-08-31', input: 2, output: 10 },
          { from: '2026-08-15', input: 3, output: 15 },
        ])
      ).toThrow(/重叠/);
    });

    it('有缝隙的窗口抛错', () => {
      expect(() =>
        validatePriceWindows('m', [
          { until: '2026-08-31', input: 2, output: 10 },
          { from: '2026-09-05', input: 3, output: 15 },
        ])
      ).toThrow(/缝隙/);
    });

    it('非首个窗口省略 from 抛错', () => {
      expect(() =>
        validatePriceWindows('m', [
          { until: '2026-08-31', input: 2, output: 10 },
          { input: 3, output: 15 },
        ])
      ).toThrow(/只有第一个窗口/);
    });

    it('空窗口抛错', () => {
      expect(() => validatePriceWindows('m', [])).toThrow(/不能为空/);
    });

    it('内置价格表全部通过校验（模块加载时已执行，这里再显式断言一次）', () => {
      // 若内置表录错，token-tracker.js 在 import 时就会 throw，本文件根本跑不到这里
      expect(resolvePricing('claude-sonnet-5', Date.parse('2026-08-20T00:00:00Z')).resolved).toBe('exact');
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
