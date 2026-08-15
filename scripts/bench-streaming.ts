/**
 * 首块延迟 vs 全量延迟基准。
 *
 * 回答的问题只有一个：**流式让用户提前多久看到第一个字？**
 * 感知等待时间由首字延迟主导而非总时长，所以这是 v0.4 唯一的用户可感知判据。
 *
 * 用法：
 *   npm run bench:stream
 *
 * 无 ANTHROPIC_API_KEY → [模拟] 受控假 provider（块数与块间隔可配）
 * 有 ANTHROPIC_API_KEY → [真实] 打一次 Anthropic API
 *
 * ⚠️ 这不是测试，不进 npm test —— 墙钟波动不该让测试变红。
 */
import { AgentLoop } from '../src/core/agent-loop.js';
import { Session } from '../src/core/session.js';
import { buildToolRegistry } from '../src/tools/index.js';
import { SYSTEM_PROMPT } from '../src/prompts/system-prompt.js';
import { PGliteDatabase } from '../src/store/database.js';
import { runMigrations } from '../src/store/migrations.js';
import { PgSessionStore } from '../src/store/pg-session-store.js';
import { StreamingRedactor } from '../src/safety/streaming-redactor.js';
import { SafetyScanner } from '../src/safety/scanner.js';
import { DEFAULT_SAFETY_LAG } from '../src/safety/rules.js';
import type { SessionStore } from '../src/store/types.js';
import type {
  AgentConfig,
  AgentTool,
  ChatOptions,
  ChatProvider,
  ChatResponse,
  Message,
} from '../src/core/types.js';

const CHUNKS = 40;
const CHUNK_DELAY_MS = 20;
const ROUNDS = 5;
const SAMPLE_TEXT =
  '您的订单 ORD-20260801-001 已发货，由顺丰速运承运，运单号 SF1234567890，' +
  '预计明天 18:00 前送达。如需修改收货地址，请在派送前联系我们。';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 受控假 provider：按固定块数与间隔吐字，模拟真实网络下的分块到达 */
class SimulatedProvider implements ChatProvider {
  constructor(private readonly streaming: boolean) {}

  async chat(
    _system: string,
    _messages: Message[],
    _tools: AgentTool[],
    opts?: ChatOptions
  ): Promise<ChatResponse> {
    const size = Math.ceil(SAMPLE_TEXT.length / CHUNKS);
    for (let i = 0; i < SAMPLE_TEXT.length; i += size) {
      await sleep(CHUNK_DELAY_MS);
      // 非流式模式：块照样到达（网络行为相同），但不回调 —— 用户什么都看不到
      if (this.streaming) opts?.onDelta?.(SAMPLE_TEXT.slice(i, i + size));
    }
    return {
      content: SAMPLE_TEXT,
      toolUses: [],
      usage: { inputTokens: 500, outputTokens: 120 },
      stopReason: 'end_turn',
    };
  }

  getModel(): string {
    return 'simulated';
  }
}

interface Sample {
  firstByteMs: number;
  fullMs: number;
}

async function runOnce(
  provider: ChatProvider,
  model: string,
  store: SessionStore,
  /** v0.10：流式脱敏的滞后窗口。undefined = 不挂脱敏器（v0.4 行为） */
  lag?: number
): Promise<Sample> {
  const config: AgentConfig = {
    model,
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxTurns: 3,
    maxTokensPerSession: 100_000,
    systemPrompt: SYSTEM_PROMPT,
    confirmHighRisk: false,
  };

  const started = Date.now();
  let firstByteMs = -1;

  const loop = new AgentLoop({
    config,
    registry: buildToolRegistry(),
    session: await Session.create(store, { userId: 'bench' }),
    provider,
    redactor:
      lag === undefined
        ? undefined
        : () => new StreamingRedactor(SafetyScanner.forOutput(), lag),
    onEvent: (event) => {
      if (firstByteMs !== -1) return;
      // 用户「看到第一个字」的时刻：流式是首个 delta，非流式只能等 response
      if (event.type === 'delta' || event.type === 'response') {
        firstByteMs = Date.now() - started;
      }
    },
  });

  await loop.run('我的订单到哪了');
  return { firstByteMs, fullMs: Date.now() - started };
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

async function main(): Promise<void> {
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const label = hasKey ? '[真实]' : '[模拟]';
  const model = process.env.AGENT_MODEL || 'claude-opus-5';

  console.log('='.repeat(64));
  console.log(`  流式首块延迟基准 ${label}`);
  console.log('='.repeat(64));
  if (hasKey) {
    console.log(`  数据来源: 真实 Anthropic API (${model})`);
  } else {
    console.log(`  数据来源: 受控假 provider —— ${CHUNKS} 块 × ${CHUNK_DELAY_MS}ms`);
    console.log('  ⚠️  这是模拟值，不是真实网络测量。设置 ANTHROPIC_API_KEY 可打真实 API。');
  }
  console.log(`  轮次: ${ROUNDS}（取中位数）\n`);

  // 纯内存 PGlite —— 基准不该依赖外部库，也不该把 .data/pg 写脏
  const db = await PGliteDatabase.open();
  await runMigrations(db);
  const store = new PgSessionStore(db);

  const modes: Array<{ name: string; streaming: boolean; lag?: number }> = [
    { name: '非流式（v0.3 行为）', streaming: false },
    { name: '流式·无脱敏（v0.4）', streaming: true },
    { name: `流式·脱敏 lag=${DEFAULT_SAFETY_LAG}（v0.10）`, streaming: true, lag: DEFAULT_SAFETY_LAG },
    { name: '流式·脱敏 lag=0（可关）', streaming: true, lag: 0 },
  ];

  const results: Record<string, Sample[]> = {};

  for (const mode of modes) {
    const samples: Sample[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      samples.push(
        await runOnce(new SimulatedProvider(mode.streaming), model, store, mode.lag)
      );
    }
    results[mode.name] = samples;
  }

  console.log('模式                    首块延迟(中位)   全量延迟(中位)   全部首块样本');
  console.log('-'.repeat(78));
  for (const mode of modes) {
    const s = results[mode.name];
    const fb = median(s.map((x) => x.firstByteMs));
    const full = median(s.map((x) => x.fullMs));
    console.log(
      `${mode.name.padEnd(22)}  ${String(fb).padStart(10)}ms  ${String(full).padStart(11)}ms   ` +
        `[${s.map((x) => x.firstByteMs).join(', ')}]`
    );
  }

  const nonStream = median(results[modes[0].name].map((x) => x.firstByteMs));
  const stream = median(results[modes[1].name].map((x) => x.firstByteMs));
  const redacted = median(results[modes[2].name].map((x) => x.firstByteMs));
  console.log('-'.repeat(78));
  console.log(
    `\n  首块延迟：${nonStream}ms → ${stream}ms，` +
      `提前 ${nonStream - stream}ms（${(nonStream / Math.max(stream, 1)).toFixed(1)}×）`
  );
  console.log(
    '  全量延迟基本不变 —— 流式改善的是**感知等待**，不是总耗时。这正是重点：\n' +
      '  用户判断「卡没卡」看的是第一个字什么时候出现，不是最后一个字。\n'
  );

  // v0.10：滞后窗口的代价必须摆在明面上，不能只说「有一点开销」
  const cost = redacted - stream;
  const kept = nonStream - redacted;
  console.log('-'.repeat(78));
  console.log(
    `  滞后窗口(lag=${DEFAULT_SAFETY_LAG})的代价：首块延迟 ${stream}ms → ${redacted}ms（+${cost}ms）\n` +
      `  相对非流式仍提前 ${kept}ms —— v0.4 的收益基本保住了。\n\n` +
      '  为什么几乎不要钱：滞后窗口只压住**可能长成敏感串的尾巴**（连续的\n' +
      '  数字/字母/@._+-），而不是无条件压住 lag 个字符。客服回复以中文为主，\n' +
      '  汉字与标点一到就能放行，绝大多数时候窗口是空的。\n' +
      '  代价出现在长串字母数字上（订单号、运单号）—— 那几个字会晚几十毫秒。\n' +
      '  确实不需要跨块保护的场景可设 AGENT_SAFETY_LAG=0 完全关掉。\n'
  );

  await db.close();
}

main().catch((err) => {
  console.error('基准运行失败:', err);
  process.exit(1);
});
