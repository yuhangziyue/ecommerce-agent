import { TokenTracker } from '../src/core/token-tracker.js';
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
