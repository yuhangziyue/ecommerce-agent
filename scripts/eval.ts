/**
 * 离线评测 + 三维回归门（v0.14）。
 *
 * 用法：
 *   npm run eval                 跑评测并与基线比对，越界则退出码非 0
 *   npm run eval -- --update     用本次结果更新基线
 *
 * ⚠️ 评的是**编排层**（意图路由 / 工具选择 / 安全脱敏 / 结构化返回），
 * 不是模型的答案质量 —— 后者需要真实 API + 人工评审。
 * 不要把这里的通过率当成「agent 质量」对外宣称。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { buildApp } from '../src/server/app.js';
import { PGliteDatabase } from '../src/store/database.js';
import { runMigrations, truncateAll } from '../src/store/migrations.js';
import { PgSessionStore } from '../src/store/pg-session-store.js';
import { PgRefundStore } from '../src/store/pg-refund-store.js';
import { PgProfileStore } from '../src/store/pg-profile-store.js';
import { PgUsageStore } from '../src/store/pg-usage-store.js';
import { PgFlowStore } from '../src/store/pg-flow-store.js';
import { PgConfirmationStore } from '../src/store/pg-confirmation-store.js';
import { PgTenantConfigStore } from '../src/store/pg-tenant-config-store.js';
import { PgApiKeyStore } from '../src/store/pg-api-key-store.js';
import { PgIdempotencyStore } from '../src/store/pg-idempotency-store.js';
import { NoOpSessionCache } from '../src/store/session-cache.js';
import { EVAL_CASES, type EvalCase } from '../src/evaluation/cases.js';
import {
  judgeCase,
  summarize,
  checkGate,
  type Baseline,
  type CaseResult,
} from '../src/evaluation/runner.js';
import { ALL_TOOLS } from '../src/tools/index.js';
import { SYSTEM_PROMPT } from '../src/prompts/system-prompt.js';
import type {
  AgentConfig,
  AgentTool,
  ChatProvider,
  ChatResponse,
} from '../src/core/types.js';

const BASELINE_PATH = new URL('../docs/eval-baseline.json', import.meta.url).pathname;
const usage = { inputTokens: 400, outputTokens: 80 };

/**
 * 脚本化 provider。
 *
 * 按 case 声明的 `expectTools` 调用工具 —— 这**不是作弊**：
 * 评测的是「工具被调用后，编排层是否正确处理」（路由收窄、安全脱敏、
 * artifact 贯通、确认拦截），而不是「模型会不会选对工具」。
 * 后者需要真实模型，属于本版明确不做的范围。
 *
 * 意图识别走的是**真实的 recognizer 代码路径**，只是模型回复被脚本化 ——
 * 所以意图解析/降级/状态机推进这些逻辑是真的被测到了。
 */
class EvalProvider implements ChatProvider {
  constructor(private readonly c: EvalCase) {}

  async chat(system: string, messages: any[], tools: AgentTool[]): Promise<ChatResponse> {
    if (system.includes('意图识别模块')) {
      // 让真实的 extractJson / 状态机跑起来，只把模型输出脚本化
      return {
        content: this.c.expectIntent
          ? JSON.stringify({ intent: this.c.expectIntent, confidence: 0.9, slots: {} })
          : '无法判断',
        toolUses: [],
        usage: { inputTokens: 50, outputTokens: 20 },
        stopReason: 'end_turn',
      };
    }

    const last = messages[messages.length - 1];
    if (last?.role === 'tool' || !this.c.expectTools?.length) {
      return {
        content: this.c.scriptedReply ?? '好的，已为您处理该请求。',
        toolUses: [],
        usage,
        stopReason: 'end_turn',
      };
    }

    // 只调用**本轮可见**的工具 —— 路由收窄若把它挡掉，这里就调不到，
    // 而那正是我们想测出来的
    const visible = new Set(tools.map((t) => t.name));
    const toCall = this.c.expectTools.filter((t) => visible.has(t));
    if (toCall.length === 0) {
      return {
        content: this.c.scriptedReply ?? '抱歉，当前无法处理该请求。',
        toolUses: [],
        usage,
        stopReason: 'end_turn',
      };
    }

    return {
      content: '',
      toolUses: toCall.map((name, i) => ({
        id: `t${i}`,
        name,
        input: inputFor(name, this.c),
      })),
      usage,
      stopReason: 'tool_use',
    };
  }

  getModel(): string {
    return 'eval-scripted';
  }
}

/** 从 case 输入里抽出工具参数。真实模型会做这件事，评测里用规则代替 */
function inputFor(tool: string, c: EvalCase): Record<string, unknown> {
  const orderId = c.input.match(/ORD-\d{8}-\d{3}/)?.[0] ?? 'ORD-20260801-001';
  switch (tool) {
    case 'order_lookup':
    case 'logistics_check':
    case 'coupon_list':
      return { orderId };
    case 'product_search':
      return { category: '电子产品' };
    case 'refund_apply':
      return { orderId, reason: '质量问题' };
    case 'invoice_apply':
      return { orderId, title: '张三' };
    default:
      return {};
  }
}

async function main(): Promise<void> {
  const update = process.argv.includes('--update');

  const db = await PGliteDatabase.open();
  await runMigrations(db);
  const stores = {
    db,
    sessions: new PgSessionStore(db),
    refunds: new PgRefundStore(db),
    profiles: new PgProfileStore(db),
    usage: new PgUsageStore(db),
    flows: new PgFlowStore(db),
    confirmations: new PgConfirmationStore(db),
    tenantConfigs: new PgTenantConfigStore(db),
    apiKeys: new PgApiKeyStore(db, 'test'),
    idempotency: new PgIdempotencyStore(db),
    cache: new NoOpSessionCache(),
    close: async () => {},
  };

  const config: AgentConfig = {
    model: 'claude-sonnet-5',
    apiKey: 'eval',
    maxTurns: 5,
    maxTokensPerSession: 1_000_000,
    systemPrompt: SYSTEM_PROMPT,
    confirmHighRisk: true,
  };

  console.log('='.repeat(72));
  console.log('  离线评测 [编排层]');
  console.log('='.repeat(72));
  console.log(`  用例数: ${EVAL_CASES.length} ｜ 工具数: ${ALL_TOOLS.length}`);
  console.log('  ⚠️  评的是编排层（意图/工具/安全/结构化），不是模型答案质量\n');

  // v1.1：评测走的是真实入口，因此也要真凭证。
  // 用 admin 是因为用例里带了 tenant_id: 't_eval'（代客口径，见 SPEC P16d）；
  // 换成不带认证的旁路会让评测测的不再是生产路径
  const evalKey = await stores.apiKeys.issue({
    tenantId: 't_eval',
    scopes: ['chat', 'read', 'write', 'admin'],
    label: 'offline-eval',
  });
  const H = { authorization: `Bearer ${evalKey.plaintext}` };

  const results: CaseResult[] = [];

  for (const c of EVAL_CASES) {
    await truncateAll(db);
    const app = await buildApp({ stores, config, provider: new EvalProvider(c) });

    const started = Date.now();
    const res = await app.inject({ headers: H,
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: c.input, user_id: 'u_eval', tenant_id: 't_eval' },
    });
    const durationMs = Date.now() - started;
    const body = JSON.parse(res.body);

    // 从会话里读实际调用的工具 —— 比信任 provider 自己的记录可靠
    const hist = await app.inject({ headers: H,
      method: 'GET',
      url: `/v1/sessions/${body.session_id}/messages`,
    });
    const messages = JSON.parse(hist.body).messages as any[];
    const toolsCalled = messages
      .flatMap((m) => m.tool_uses ?? [])
      .map((t: any) => t.name);

    // 意图要**先取到再判定** —— sync 接口不返回意图（那是接口设计的事实），
    // 只能从 SSE 的 intent 事件拿。先判定再补取的话，judgeCase 会拿着
    // undefined 记一笔失败，而后面那次补取根本救不回来
    let intent: string | undefined;
    if (c.expectIntent) {
      const sse = await app.inject({ headers: H,
        method: 'POST',
        url: '/v1/chat',
        payload: { message: c.input, user_id: 'u_eval', tenant_id: 't_eval' },
      });
      const intentFrame = sse.body
        .split('\n\n')
        .find((b) => b.startsWith('event: intent'));
      intent = intentFrame
        ? JSON.parse(intentFrame.split('\n')[1].slice(6)).intent
        : undefined;
    }

    const failures = judgeCase(c, {
      reply: body.reply ?? '',
      toolsCalled,
      artifactTypes: (body.artifacts ?? []).map((a: any) => a.type),
      intent,
      blockedBy: body.blocked?.[0]?.by,
      tokens: (body.usage?.input_tokens ?? 0) + (body.usage?.output_tokens ?? 0),
      durationMs,
    });

    await app.close();

    const passed = failures.length === 0;
    results.push({
      id: c.id,
      dimension: c.dimension,
      passed,
      failures,
      tokens: (body.usage?.input_tokens ?? 0) + (body.usage?.output_tokens ?? 0),
      durationMs,
    });

    console.log(
      `  ${passed ? '✓' : '✗'} [${c.dimension}] ${c.id}` +
        (passed ? '' : `\n      ${failures.join('\n      ')}`)
    );
  }

  const report = summarize(results);

  console.log('\n' + '-'.repeat(72));
  console.log(
    `  总通过率: ${report.passed}/${report.total} = ${(report.passRate * 100).toFixed(1)}%`
  );
  for (const [dim, d] of Object.entries(report.byDimension)) {
    console.log(
      `    ${dim.padEnd(12)} ${d.passed}/${d.total} = ${(d.passRate * 100).toFixed(1)}%`
    );
  }
  console.log(`  每 case 平均 token: ${report.avgTokens.toFixed(0)}`);
  console.log(`  p95 延迟: ${report.p95DurationMs.toFixed(0)}ms`);

  if (update) {
    const baseline: Baseline = {
      passRate: report.passRate,
      avgTokens: report.avgTokens,
      p95DurationMs: report.p95DurationMs,
      recordedAt: new Date().toISOString(),
    };
    writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
    console.log(`\n  基线已更新: ${BASELINE_PATH}`);
    await db.close();
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    console.log('\n  ⚠️  没有基线文件，跳过回归门。用 `npm run eval -- --update` 建立基线。');
    await db.close();
    process.exit(report.passRate < 1 ? 1 : 0);
  }

  const baseline: Baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  const gate = checkGate(report, baseline);

  console.log('\n' + '='.repeat(72));
  console.log('  三维回归门');
  console.log('='.repeat(72));
  for (const c of gate.checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.dimension.padEnd(8)} ${c.message}`);
  }
  console.log(
    `\n  基线记录于 ${baseline.recordedAt}` +
      '\n  三维一起看是刻意的：只看质量会让人用多调工具换通过率，' +
      '\n  只看成本会让人砍掉必要的检查。\n'
  );

  await db.close();
  process.exit(gate.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('评测运行失败:', err);
  process.exit(1);
});
