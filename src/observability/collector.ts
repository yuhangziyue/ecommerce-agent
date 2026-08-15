import { MetricsRegistry, type Counter, type Histogram } from './metrics.js';
import type { EventBus } from '../core/event-bus.js';
import type { AgentEvent } from '../core/types.js';

/**
 * 指标采集器。
 *
 * **挂在 EventBus 上，AgentLoop 一行不改** —— 这是 v0.4 把事件分发收敛到总线
 * 换来的第三次红利（前两次是 v0.6 的 SSE 写出器、v0.10 的安全事件）。
 * 埋点如果要往 Loop 里塞 `metrics.inc()`，那才是真的侵入。
 *
 * 标签只用**有限枚举**（工具名、outcome）。sessionId / tenantId 之类
 * 高基数的东西一律不进标签 —— 那是 Prometheus 的经典事故来源：
 * 每个不同的标签值都是一条独立时间序列，百万会话 = 百万时间序列 = 内存爆掉。
 */
export interface AgentMetrics {
  turns: Counter;
  turnDuration: Histogram;
  toolCalls: Counter;
  toolDuration: Histogram;
  tokens: Counter;
  cost: Counter;
  blocked: Counter;
  safetyActions: Counter;
  confirmations: Counter;
}

export function buildMetrics(registry: MetricsRegistry): AgentMetrics {
  return {
    turns: registry.counter('agent_turns_total', '对话轮次总数（按结果分）', ['outcome']),
    turnDuration: registry.histogram(
      'agent_turn_duration_seconds',
      '单轮对话耗时（秒）'
    ),
    toolCalls: registry.counter('agent_tool_calls_total', '工具调用总数', [
      'tool',
      'status',
    ]),
    toolDuration: registry.histogram('agent_tool_duration_seconds', '工具执行耗时（秒）', [
      'tool',
    ]),
    tokens: registry.counter('agent_tokens_total', 'token 消耗总数（按类型分）', ['kind']),
    cost: registry.counter('agent_cost_usd_total', '累计成本（美元）'),
    blocked: registry.counter('agent_blocked_total', '被拦截的轮次（按拦截方分）', ['by']),
    safetyActions: registry.counter('agent_safety_actions_total', '安全处置计数', [
      'stage',
      'action',
    ]),
    confirmations: registry.counter('agent_confirmations_total', '异步确认计数', [
      'outcome',
    ]),
  };
}

/**
 * 把一条事件流接进指标。返回退订函数。
 *
 * `turnStartedAt` 由调用方给 —— 采集器不该自己决定「一轮从什么时候开始」，
 * 那是 HTTP 层的概念（请求进来的时刻），不是事件流里的信息。
 */
export function collectFrom(
  bus: EventBus,
  metrics: AgentMetrics,
  turnStartedAt: number = Date.now()
): () => void {
  let outcome: 'ok' | 'blocked' | 'error' | 'cancelled' = 'ok';

  return bus.subscribe((event: AgentEvent) => {
    switch (event.type) {
      case 'tool_end': {
        const status = event.result.isError ? 'error' : 'ok';
        metrics.toolCalls.inc({ tool: event.toolName, status });
        metrics.toolDuration.observe(event.durationMs / 1000, { tool: event.toolName });
        break;
      }
      case 'tool_rejected':
        // 单独一个 status，不混进 ok/error —— 「被拦下」和「执行失败」
        // 是完全不同的两件事，混在一起会让排查走错方向
        metrics.toolCalls.inc({ tool: event.toolName, status: 'rejected' });
        break;
      case 'blocked':
        outcome = 'blocked';
        metrics.blocked.inc({ by: event.by });
        break;
      case 'error':
        outcome = 'error';
        break;
      case 'cancelled':
        // 用户关页面不是系统错误。混进 error 会让错误率变成噪声，
        // 真故障反而被淹没
        outcome = 'cancelled';
        break;
      case 'done': {
        metrics.turns.inc({ outcome });
        metrics.turnDuration.observe((Date.now() - turnStartedAt) / 1000);
        metrics.tokens.inc({ kind: 'input' }, event.totalTokens.inputTokens);
        metrics.tokens.inc({ kind: 'output' }, event.totalTokens.outputTokens);
        if (event.totalTokens.cacheReadTokens) {
          metrics.tokens.inc({ kind: 'cache_read' }, event.totalTokens.cacheReadTokens);
        }
        if (event.totalTokens.cacheWriteTokens) {
          metrics.tokens.inc({ kind: 'cache_write' }, event.totalTokens.cacheWriteTokens);
        }
        metrics.cost.inc({}, event.totalCost);
        break;
      }
      default:
        break;
    }
  });
}

/**
 * 误杀率报表（还 v0.10 的账）。
 *
 * v0.10 让每次非 allow 的安全裁决都落审计，说好「v0.14 度量误杀率」——
 * 数据攒了两个版本，一直没算过。
 *
 * ⚠️ **口径要说清楚**：这里算的是「拦截构成」，不是真正的误杀率。
 * 真误杀率需要人工标注哪些拦截是错的（那是标注工作，不是代码能算的）。
 * 本报表提供的是**筛查线索**：某条规则占了 90% 的拦截量，它多半有问题。
 */
export interface SafetyReport {
  totalActions: number;
  byRule: Array<{ ruleId: string; ruleName: string; count: number; share: number }>;
  byStage: Record<string, number>;
  byAction: Record<string, number>;
  /** 触发拦截的会话占比 —— 突然升高通常意味着规则写宽了 */
  blockRate: number;
}

export function buildSafetyReport(
  audits: Array<{
    stage: string;
    action: string;
    matches: Array<{ ruleId: string; ruleName: string }>;
  }>,
  totalSessions: number
): SafetyReport {
  const byRule = new Map<string, { ruleName: string; count: number }>();
  const byStage: Record<string, number> = {};
  const byAction: Record<string, number> = {};
  let totalActions = 0;

  for (const a of audits) {
    totalActions++;
    byStage[a.stage] = (byStage[a.stage] ?? 0) + 1;
    byAction[a.action] = (byAction[a.action] ?? 0) + 1;

    // 同一条裁决里同一规则命中多次只算一次 —— 否则一段文本里有 3 个手机号
    // 会让 pii.phone 的占比虚高 3 倍
    const seen = new Set<string>();
    for (const m of a.matches) {
      if (seen.has(m.ruleId)) continue;
      seen.add(m.ruleId);
      const entry = byRule.get(m.ruleId) ?? { ruleName: m.ruleName, count: 0 };
      entry.count++;
      byRule.set(m.ruleId, entry);
    }
  }

  const ruleTotal = [...byRule.values()].reduce((s, r) => s + r.count, 0);

  return {
    totalActions,
    byRule: [...byRule.entries()]
      .map(([ruleId, v]) => ({
        ruleId,
        ruleName: v.ruleName,
        count: v.count,
        share: ruleTotal > 0 ? v.count / ruleTotal : 0,
      }))
      .sort((a, b) => b.count - a.count),
    byStage,
    byAction,
    blockRate: totalSessions > 0 ? (byAction.block ?? 0) / totalSessions : 0,
  };
}
