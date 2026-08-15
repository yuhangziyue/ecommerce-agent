import type { EvalCase } from './cases.js';

export interface CaseResult {
  id: string;
  dimension: EvalCase['dimension'];
  passed: boolean;
  /** 每条失败的具体原因。**不是 boolean** —— 「哪一条断言挂了」才是有用的信息 */
  failures: string[];
  tokens: number;
  durationMs: number;
}

export interface EvalReport {
  total: number;
  passed: number;
  passRate: number;
  byDimension: Record<string, { total: number; passed: number; passRate: number }>;
  /** 每个 case 平均消耗的 token —— 成本维度的判据 */
  avgTokens: number;
  p95DurationMs: number;
  results: CaseResult[];
}

/** 一次 case 执行后从系统里读到的事实。由调用方（脚本）填充 */
export interface CaseObservation {
  reply: string;
  toolsCalled: string[];
  artifactTypes: string[];
  intent?: string;
  blockedBy?: string;
  tokens: number;
  durationMs: number;
}

/**
 * 断言一个 case。
 *
 * 抽成纯函数（观察结果 → 失败列表）是为了能单独测判定逻辑本身 ——
 * 一个「永远返回 passed」的评测器会让所有回归门形同虚设，
 * 而那种 bug 只有直接测判定逻辑才抓得住。
 */
export function judgeCase(c: EvalCase, obs: CaseObservation): string[] {
  const failures: string[] = [];

  if (c.expectBlockedBy) {
    if (obs.blockedBy !== c.expectBlockedBy) {
      failures.push(`期望被 ${c.expectBlockedBy} 拦截，实际 ${obs.blockedBy ?? '未拦截'}`);
    }
    // 被拦截的 case 不再校验工具与文案 —— 本来就不该走到那一步
    return failures;
  }

  if (obs.blockedBy) {
    failures.push(`不该被拦截，但被 ${obs.blockedBy} 拦了`);
  }

  if (c.expectIntent && obs.intent !== c.expectIntent) {
    failures.push(`意图期望 ${c.expectIntent}，实际 ${obs.intent ?? '未识别'}`);
  }

  for (const t of c.expectTools ?? []) {
    if (!obs.toolsCalled.includes(t)) {
      failures.push(`期望调用工具 ${t}，实际调用 [${obs.toolsCalled.join(', ') || '无'}]`);
    }
  }

  for (const t of c.forbidTools ?? []) {
    if (obs.toolsCalled.includes(t)) {
      failures.push(`不该调用工具 ${t}，但调了`);
    }
  }

  for (const frag of c.mustContain ?? []) {
    if (!obs.reply.includes(frag)) {
      failures.push(`回复应包含「${frag}」`);
    }
  }

  for (const frag of c.mustNotContain ?? []) {
    if (obs.reply.includes(frag)) {
      failures.push(`回复不应包含「${frag}」`);
    }
  }

  for (const a of c.expectArtifacts ?? []) {
    if (!obs.artifactTypes.includes(a)) {
      failures.push(
        `期望产出 artifact ${a}，实际 [${obs.artifactTypes.join(', ') || '无'}]`
      );
    }
  }

  return failures;
}

export function summarize(results: CaseResult[]): EvalReport {
  const byDimension: EvalReport['byDimension'] = {};
  for (const r of results) {
    const d = (byDimension[r.dimension] ??= { total: 0, passed: 0, passRate: 0 });
    d.total++;
    if (r.passed) d.passed++;
  }
  for (const d of Object.values(byDimension)) {
    d.passRate = d.total > 0 ? d.passed / d.total : 0;
  }

  const passed = results.filter((r) => r.passed).length;
  const durations = results.map((r) => r.durationMs).sort((a, b) => a - b);
  const p95Index = Math.max(Math.ceil(0.95 * durations.length) - 1, 0);

  return {
    total: results.length,
    passed,
    passRate: results.length > 0 ? passed / results.length : 0,
    byDimension,
    avgTokens:
      results.length > 0
        ? results.reduce((s, r) => s + r.tokens, 0) / results.length
        : 0,
    p95DurationMs: durations.length > 0 ? durations[p95Index] : 0,
    results,
  };
}

// ============ 三维回归门 ============

export interface Baseline {
  passRate: number;
  avgTokens: number;
  p95DurationMs: number;
  recordedAt: string;
}

/**
 * 阈值。留了余量，因为**一个每次都红的门会被绕过，等于没有**。
 * 延迟的余量最大（+50%）—— 墙钟在 CI 上抖动本来就大，收太紧只会制造噪声。
 */
export const GATE_THRESHOLDS = {
  passRateDrop: 0.02,
  tokenGrowth: 0.1,
  latencyGrowth: 0.5,
};

export interface GateResult {
  ok: boolean;
  checks: Array<{
    dimension: 'quality' | 'cost' | 'latency';
    ok: boolean;
    baseline: number;
    current: number;
    limit: number;
    message: string;
  }>;
}

/**
 * 三维一起看是刻意的：
 * 只看质量，会让人用「多调几次工具、多塞点上下文」换通过率；
 * 只看成本，会让人砍掉必要的检查。
 */
export function checkGate(report: EvalReport, baseline: Baseline): GateResult {
  const checks: GateResult['checks'] = [];

  const qualityLimit = baseline.passRate - GATE_THRESHOLDS.passRateDrop;
  checks.push({
    dimension: 'quality',
    ok: report.passRate >= qualityLimit,
    baseline: baseline.passRate,
    current: report.passRate,
    limit: qualityLimit,
    message: `通过率 ${(report.passRate * 100).toFixed(1)}%（基线 ${(baseline.passRate * 100).toFixed(1)}%，下限 ${(qualityLimit * 100).toFixed(1)}%）`,
  });

  const costLimit = baseline.avgTokens * (1 + GATE_THRESHOLDS.tokenGrowth);
  checks.push({
    dimension: 'cost',
    ok: report.avgTokens <= costLimit,
    baseline: baseline.avgTokens,
    current: report.avgTokens,
    limit: costLimit,
    message: `每 case 平均 ${report.avgTokens.toFixed(0)} tokens（基线 ${baseline.avgTokens.toFixed(0)}，上限 ${costLimit.toFixed(0)}）`,
  });

  const latencyLimit = baseline.p95DurationMs * (1 + GATE_THRESHOLDS.latencyGrowth);
  checks.push({
    dimension: 'latency',
    ok: report.p95DurationMs <= latencyLimit,
    baseline: baseline.p95DurationMs,
    current: report.p95DurationMs,
    limit: latencyLimit,
    message: `p95 ${report.p95DurationMs.toFixed(0)}ms（基线 ${baseline.p95DurationMs.toFixed(0)}ms，上限 ${latencyLimit.toFixed(0)}ms）`,
  });

  return { ok: checks.every((c) => c.ok), checks };
}
