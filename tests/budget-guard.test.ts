import { describe, it, expect } from 'vitest';
import { TokenTracker } from '../src/core/token-tracker.js';
import { BudgetGuard } from '../src/guardrails/budget-guard.js';

const MODEL = 'claude-sonnet-4-20250514';

describe('BudgetGuard', () => {
  it('defaults to maxTokens=100000 and warningThreshold=0.8', () => {
    const tracker = new TokenTracker();
    const guard = new BudgetGuard(tracker);
    // Under threshold: allowed, no warning
    const result = guard.check();
    expect(result.allowed).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(result.utilization).toBe(0);
  });

  it('allows and gives no warning when under the threshold', () => {
    const tracker = new TokenTracker();
    const guard = new BudgetGuard(tracker, 1000, 0.8);
    tracker.add({ inputTokens: 100, outputTokens: 100 }, MODEL);
    const result = guard.check();
    expect(result.allowed).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(result.utilization).toBeCloseTo(0.2);
  });

  it('allows but warns when at or above the warning threshold (80%)', () => {
    const tracker = new TokenTracker();
    const guard = new BudgetGuard(tracker, 1000, 0.8);
    tracker.add({ inputTokens: 400, outputTokens: 400 }, MODEL);
    const result = guard.check();
    expect(result.allowed).toBe(true);
    expect(result.warning).toBeDefined();
    expect(result.utilization).toBeCloseTo(0.8);
  });

  it('disallows and warns when at 100% utilization', () => {
    const tracker = new TokenTracker();
    const guard = new BudgetGuard(tracker, 1000, 0.8);
    tracker.add({ inputTokens: 500, outputTokens: 500 }, MODEL);
    const result = guard.check();
    expect(result.allowed).toBe(false);
    expect(result.warning).toBeDefined();
    expect(result.utilization).toBeCloseTo(1.0);
  });

  it('disallows when over 100% utilization', () => {
    const tracker = new TokenTracker();
    const guard = new BudgetGuard(tracker, 1000, 0.8);
    tracker.add({ inputTokens: 600, outputTokens: 600 }, MODEL);
    const result = guard.check();
    expect(result.allowed).toBe(false);
    expect(result.utilization).toBeCloseTo(1.2);
  });

  it('calculates utilization as totalTokens / maxTokens', () => {
    const tracker = new TokenTracker();
    const guard = new BudgetGuard(tracker, 2000, 0.8);
    tracker.add({ inputTokens: 300, outputTokens: 200 }, MODEL);
    const result = guard.check();
    // totalTokens = 300 + 200 = 500, utilization = 500/2000 = 0.25
    expect(result.utilization).toBeCloseTo(0.25);
  });

  it('respects a custom warning threshold', () => {
    const tracker = new TokenTracker();
    const guard = new BudgetGuard(tracker, 1000, 0.5);
    tracker.add({ inputTokens: 250, outputTokens: 250 }, MODEL);
    // 50% utilization, threshold is 0.5 => should warn
    const result = guard.check();
    expect(result.allowed).toBe(true);
    expect(result.warning).toBeDefined();
  });
});
