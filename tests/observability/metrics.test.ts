import { MetricsRegistry, Histogram, DEFAULT_BUCKETS } from '../../src/observability/metrics.js';
import { buildMetrics, collectFrom, buildSafetyReport } from '../../src/observability/collector.js';
import { EventBus } from '../../src/core/event-bus.js';
import {
  judgeCase,
  summarize,
  checkGate,
  GATE_THRESHOLDS,
  type CaseResult,
} from '../../src/evaluation/runner.js';
import type { EvalCase } from '../../src/evaluation/cases.js';

describe('MetricsRegistry · Prometheus 文本格式', () => {
  let reg: MetricsRegistry;
  beforeEach(() => {
    reg = new MetricsRegistry();
  });

  it('counter 渲染出 HELP / TYPE / 值', () => {
    const c = reg.counter('test_total', '测试计数', ['kind']);
    c.inc({ kind: 'a' });
    c.inc({ kind: 'a' });
    c.inc({ kind: 'b' }, 5);

    const out = reg.render();
    expect(out).toContain('# HELP test_total 测试计数');
    expect(out).toContain('# TYPE test_total counter');
    expect(out).toContain('test_total{kind="a"} 2');
    expect(out).toContain('test_total{kind="b"} 5');
  });

  it('🔴 标签键序不影响时间序列身份（否则 {a,b} 与 {b,a} 会被算成两条）', () => {
    const c = reg.counter('t_total', 'x', ['a', 'b']);
    c.inc({ a: '1', b: '2' });
    c.inc({ b: '2', a: '1' });
    expect(c.get({ a: '1', b: '2' })).toBe(2);
  });

  it('🔴 未声明的标签直接抛错（白名单是防基数爆炸的第一道闸）', () => {
    const c = reg.counter('t_total', 'x', ['kind']);
    expect(() => c.inc({ session_id: 'sesn_1' })).toThrow('不接受标签');
  });

  it('🔴 标签值里的引号与反斜杠被转义（否则整个抓取解析失败）', () => {
    const c = reg.counter('t_total', 'x', ['name']);
    c.inc({ name: 'he said "hi"\\path' });
    expect(reg.render()).toContain('name="he said \\"hi\\"\\\\path"');
  });

  it('counter 不能减少', () => {
    const c = reg.counter('t_total', 'x');
    expect(() => c.inc({}, -1)).toThrow('不能减少');
  });

  it('gauge 可以任意设置', () => {
    const g = reg.gauge('t_gauge', 'x');
    g.set(42);
    g.set(7);
    expect(g.get()).toBe(7);
    expect(reg.render()).toContain('t_gauge 7');
  });

  it('重复注册返回同一实例（多处装配同一指标是常态）', () => {
    const a = reg.counter('same_total', 'x');
    const b = reg.counter('same_total', 'y');
    a.inc();
    expect(b.get()).toBe(1);
  });

  it('输出按指标名排序（便于 diff 与断言）', () => {
    reg.counter('z_total', 'z').inc();
    reg.counter('a_total', 'a').inc();
    const out = reg.render();
    expect(out.indexOf('a_total')).toBeLessThan(out.indexOf('z_total'));
  });
});

describe('Histogram · 分位数与桶', () => {
  it('🔴 分位数用已知分布验算', () => {
    const h = new Histogram('h', 'x', [], DEFAULT_BUCKETS);
    // 1..100 各一个样本
    for (let i = 1; i <= 100; i++) h.observe(i);

    expect(h.quantile(0.5)).toBe(50);
    expect(h.quantile(0.95)).toBe(95);
    expect(h.quantile(0.99)).toBe(99);
    expect(h.quantile(1)).toBe(100);
  });

  it('单个样本时各分位数都是它', () => {
    const h = new Histogram('h', 'x');
    h.observe(3.5);
    expect(h.quantile(0.5)).toBe(3.5);
    expect(h.quantile(0.95)).toBe(3.5);
  });

  it('无样本时返回 0 而不是 NaN', () => {
    expect(new Histogram('h', 'x').quantile(0.95)).toBe(0);
  });

  it('🔴 桶是累计语义（le=0.5 的计数包含所有 ≤0.5 的样本）', () => {
    const h = new Histogram('h', 'x', [], [0.1, 0.5, 1]);
    h.observe(0.05);
    h.observe(0.3);
    h.observe(0.8);

    const out = h.render().join('\n');
    expect(out).toContain('h_bucket{le="0.1"} 1');
    expect(out).toContain('h_bucket{le="0.5"} 2'); // 累计，不是区间
    expect(out).toContain('h_bucket{le="1"} 3');
    expect(out).toContain('h_bucket{le="+Inf"} 3');
  });

  it('🔴 缺 +Inf 桶会让抓取端算不出总数 —— 必须有', () => {
    const h = new Histogram('h', 'x', [], [1]);
    h.observe(99); // 超出所有桶
    const out = h.render().join('\n');
    expect(out).toContain('h_bucket{le="+Inf"} 1');
    expect(out).toContain('h_count 1');
  });

  it('sum 与 count 正确', () => {
    const h = new Histogram('h', 'x');
    h.observe(1);
    h.observe(2);
    expect(h.sum()).toBe(3);
    expect(h.count()).toBe(2);
  });

  it('🔴 桶边界非升序时装配即失败（不等抓取时才发现）', () => {
    expect(() => new Histogram('h', 'x', [], [1, 0.5])).toThrow('严格升序');
  });
});

describe('指标采集 · 挂在 EventBus 上（AgentLoop 零改动）', () => {
  it('工具调用与耗时被记录', () => {
    const reg = new MetricsRegistry();
    const metrics = buildMetrics(reg);
    const bus = new EventBus();
    collectFrom(bus, metrics);

    bus.emit({
      type: 'tool_end',
      toolName: 'order_lookup',
      result: { content: 'ok' },
      durationMs: 120,
    });
    bus.emit({
      type: 'tool_end',
      toolName: 'order_lookup',
      result: { content: 'bad', isError: true },
      durationMs: 30,
    });

    expect(metrics.toolCalls.get({ tool: 'order_lookup', status: 'ok' })).toBe(1);
    expect(metrics.toolCalls.get({ tool: 'order_lookup', status: 'error' })).toBe(1);
    expect(metrics.toolDuration.count({ tool: 'order_lookup' })).toBe(2);
  });

  it('🔴 被拦截的轮次记为 blocked 而不是 ok', () => {
    const reg = new MetricsRegistry();
    const metrics = buildMetrics(reg);
    const bus = new EventBus();
    collectFrom(bus, metrics);

    bus.emit({ type: 'blocked', by: 'safety', reason: 'x' });
    bus.emit({
      type: 'done',
      totalTokens: { inputTokens: 10, outputTokens: 5 },
      totalCost: 0.001,
    });

    expect(metrics.turns.get({ outcome: 'blocked' })).toBe(1);
    expect(metrics.turns.get({ outcome: 'ok' })).toBe(0);
    expect(metrics.blocked.get({ by: 'safety' })).toBe(1);
  });

  it('token 与成本被累加', () => {
    const reg = new MetricsRegistry();
    const metrics = buildMetrics(reg);
    const bus = new EventBus();
    collectFrom(bus, metrics);

    bus.emit({
      type: 'done',
      totalTokens: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 500,
        cacheWriteTokens: 50,
      },
      totalCost: 0.05,
    });

    expect(metrics.tokens.get({ kind: 'input' })).toBe(100);
    expect(metrics.tokens.get({ kind: 'cache_read' })).toBe(500);
    expect(metrics.cost.get()).toBeCloseTo(0.05, 10);
  });

  it('退订后不再采集', () => {
    const reg = new MetricsRegistry();
    const metrics = buildMetrics(reg);
    const bus = new EventBus();
    const off = collectFrom(bus, metrics);
    off();

    bus.emit({
      type: 'done',
      totalTokens: { inputTokens: 1, outputTokens: 1 },
      totalCost: 0,
    });
    expect(metrics.turns.get({ outcome: 'ok' })).toBe(0);
  });
});

describe('安全报表（还 v0.10 的账）', () => {
  const audit = (stage: string, action: string, rules: string[]) => ({
    stage,
    action,
    matches: rules.map((r) => ({ ruleId: r, ruleName: r })),
  });

  it('按规则统计命中数与占比', () => {
    const r = buildSafetyReport(
      [
        audit('input', 'block', ['inject.a']),
        audit('input', 'block', ['inject.a']),
        audit('output', 'mask', ['pii.phone']),
      ],
      10
    );

    expect(r.totalActions).toBe(3);
    expect(r.byRule[0]).toMatchObject({ ruleId: 'inject.a', count: 2 });
    expect(r.byRule[0].share).toBeCloseTo(2 / 3, 10);
    expect(r.byStage).toEqual({ input: 2, output: 1 });
    expect(r.blockRate).toBeCloseTo(0.2, 10);
  });

  it('🔴 同一裁决里同一规则命中多次只算一次（否则占比虚高）', () => {
    // 一段文本里有 3 个手机号
    const r = buildSafetyReport(
      [audit('output', 'mask', ['pii.phone', 'pii.phone', 'pii.phone'])],
      1
    );
    expect(r.byRule[0].count).toBe(1);
  });

  it('空数据不炸且不产生 NaN', () => {
    const r = buildSafetyReport([], 0);
    expect(r.totalActions).toBe(0);
    expect(r.blockRate).toBe(0);
    expect(r.byRule).toEqual([]);
  });
});

describe('评测判定逻辑', () => {
  const base: EvalCase = { id: 'x', dimension: 'tool_choice', input: 'hi' };
  const obs = (over: Partial<Parameters<typeof judgeCase>[1]> = {}) => ({
    reply: '',
    toolsCalled: [] as string[],
    artifactTypes: [] as string[],
    tokens: 0,
    durationMs: 0,
    ...over,
  });

  it('全部满足时零失败', () => {
    expect(
      judgeCase(
        { ...base, expectTools: ['a'], mustContain: ['hi'] },
        obs({ toolsCalled: ['a'], reply: 'hi there' })
      )
    ).toEqual([]);
  });

  it('🔴 每条失败都给出具体原因（不是 boolean）', () => {
    const f = judgeCase(
      { ...base, expectTools: ['a'], mustContain: ['x'] },
      obs({ toolsCalled: ['b'], reply: 'y' })
    );
    expect(f).toHaveLength(2);
    expect(f[0]).toContain('期望调用工具 a');
    expect(f[0]).toContain('实际调用 [b]');
  });

  it('forbidTools 命中即失败', () => {
    const f = judgeCase({ ...base, forbidTools: ['x'] }, obs({ toolsCalled: ['x'] }));
    expect(f[0]).toContain('不该调用工具 x');
  });

  it('mustNotContain 命中即失败', () => {
    const f = judgeCase(
      { ...base, mustNotContain: ['13812345678'] },
      obs({ reply: '电话 13812345678' })
    );
    expect(f[0]).toContain('不应包含');
  });

  it('🔴 期望被拦截时不再校验工具与文案（本来就不该走到那一步）', () => {
    const f = judgeCase(
      { ...base, expectBlockedBy: 'safety', expectTools: ['a'], mustContain: ['x'] },
      obs({ blockedBy: 'safety' })
    );
    expect(f).toEqual([]);
  });

  it('🔴 不该被拦却被拦了要报出来', () => {
    const f = judgeCase(base, obs({ blockedBy: 'quota' }));
    expect(f[0]).toContain('不该被拦截');
  });

  it('意图不符要报出来', () => {
    const f = judgeCase({ ...base, expectIntent: 'refund' }, obs({ intent: 'order_query' }));
    expect(f[0]).toContain('意图期望 refund');
  });

  it('artifact 缺失要报出来', () => {
    const f = judgeCase({ ...base, expectArtifacts: ['product_list'] }, obs());
    expect(f[0]).toContain('期望产出 artifact product_list');
  });
});

describe('三维回归门', () => {
  const results = (n: number, passed: number, tokens: number, ms: number): CaseResult[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `c${i}`,
      dimension: 'tool_choice' as const,
      passed: i < passed,
      failures: [],
      tokens,
      durationMs: ms,
    }));

  const baseline = {
    passRate: 1,
    avgTokens: 700,
    p95DurationMs: 40,
    recordedAt: '2026-08-15T00:00:00Z',
  };

  it('三维都在阈值内 → 放行', () => {
    const gate = checkGate(summarize(results(10, 10, 700, 40)), baseline);
    expect(gate.ok).toBe(true);
  });

  it('🔴 质量下滑超阈值 → 拦', () => {
    const gate = checkGate(summarize(results(10, 8, 700, 40)), baseline);
    expect(gate.ok).toBe(false);
    expect(gate.checks.find((c) => c.dimension === 'quality')!.ok).toBe(false);
  });

  it('🔴 成本增长超阈值 → 拦', () => {
    const gate = checkGate(summarize(results(10, 10, 900, 40)), baseline);
    expect(gate.ok).toBe(false);
    expect(gate.checks.find((c) => c.dimension === 'cost')!.ok).toBe(false);
  });

  it('🔴 延迟增长超阈值 → 拦', () => {
    const gate = checkGate(summarize(results(10, 10, 700, 200)), baseline);
    expect(gate.ok).toBe(false);
    expect(gate.checks.find((c) => c.dimension === 'latency')!.ok).toBe(false);
  });

  it('阈值内的小幅波动放行（每次都红的门会被绕过）', () => {
    const withinAll = summarize(
      results(100, 99, 700 * (1 + GATE_THRESHOLDS.tokenGrowth * 0.9), 40 * 1.4)
    );
    expect(checkGate(withinAll, baseline).ok).toBe(true);
  });

  it('分维度统计通过率', () => {
    const mixed: CaseResult[] = [
      { id: 'a', dimension: 'safety', passed: true, failures: [], tokens: 1, durationMs: 1 },
      { id: 'b', dimension: 'safety', passed: false, failures: ['x'], tokens: 1, durationMs: 1 },
      { id: 'c', dimension: 'intent', passed: true, failures: [], tokens: 1, durationMs: 1 },
    ];
    const r = summarize(mixed);
    expect(r.byDimension.safety.passRate).toBe(0.5);
    expect(r.byDimension.intent.passRate).toBe(1);
  });

  it('空结果集不产生 NaN', () => {
    const r = summarize([]);
    expect(r.passRate).toBe(0);
    expect(r.avgTokens).toBe(0);
    expect(r.p95DurationMs).toBe(0);
  });
});

describe('被拦下的工具调用不再隐形（v0.14 补的观测盲区）', () => {
  it('🔴 tool_rejected 单独计一个 status，不混进 ok/error', () => {
    const reg = new MetricsRegistry();
    const metrics = buildMetrics(reg);
    const bus = new EventBus();
    collectFrom(bus, metrics);

    bus.emit({
      type: 'tool_rejected',
      toolName: 'refund_apply',
      reason: '该操作需要客户确认后才能执行',
    });

    expect(metrics.toolCalls.get({ tool: 'refund_apply', status: 'rejected' })).toBe(1);
    // 「被拦下」和「执行失败」是两件事，混在一起会让排查走错方向
    expect(metrics.toolCalls.get({ tool: 'refund_apply', status: 'error' })).toBe(0);
    expect(metrics.toolCalls.get({ tool: 'refund_apply', status: 'ok' })).toBe(0);
  });

  it('被拦下的调用不计入执行耗时（它根本没执行）', () => {
    const reg = new MetricsRegistry();
    const metrics = buildMetrics(reg);
    const bus = new EventBus();
    collectFrom(bus, metrics);

    bus.emit({ type: 'tool_rejected', toolName: 'refund_apply', reason: 'x' });
    expect(metrics.toolDuration.count({ tool: 'refund_apply' })).toBe(0);
  });
});
