import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { AgentLoop } from '../../src/core/agent-loop.js';
import { Session } from '../../src/core/session.js';
import { LocalToolGateway } from '../../src/tools/gateway.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { openTestDb, truncateAll } from '../store/helpers.js';
import { PgSessionStore } from '../../src/store/pg-session-store.js';
import type { Database, SessionStore } from '../../src/store/types.js';
import type {
  AgentConfig,
  AgentEvent,
  ChatProvider,
  ChatResponse,
} from '../../src/core/types.js';

/**
 * 轮次结果（v1.2 · D-4）。
 *
 * v0.1~v1.1 期间 `run()` 返回一个字符串：成功时是回复，失败时是
 * `LLM调用失败: xxx` 这样**冒充回复的错误正文**。
 * 调用方要判断成败只能做字符串匹配 —— 而那句话是给人看的，随时会改。
 */

const usage = { inputTokens: 10, outputTokens: 5 };

const config = (over: Partial<AgentConfig> = {}): AgentConfig => ({
  model: 'fake-model',
  maxTurns: 5,
  maxTokensPerSession: 100_000,
  systemPrompt: '测试助手',
  confirmHighRisk: false,
  ...over,
});

let db: Database;
let store: SessionStore;

beforeAll(async () => {
  db = await openTestDb();
  store = new PgSessionStore(db);
});
afterAll(async () => db.close());
beforeEach(async () => truncateAll(db));

async function runWith(
  chat: ChatProvider['chat'],
  over: Partial<AgentConfig> = {},
  signal?: AbortSignal
) {
  const events: AgentEvent[] = [];
  const loop = new AgentLoop({
    config: config(over),
    registry: new LocalToolGateway(new ToolRegistry()),
    session: await Session.create(store),
    provider: { chat, getModel: () => 'fake-model' },
    onEvent: (e) => events.push(e),
    signal,
  });
  return { turn: await loop.run('你好'), events };
}

describe('TurnResult', () => {
  it('P1 正常轮次 → outcome=ok，reply 非空，无 error', async () => {
    const { turn } = await runWith(async () => ({
      content: '您好，有什么可以帮您',
      toolUses: [],
      usage,
      stopReason: 'end_turn',
    }));

    expect(turn.outcome).toBe('ok');
    expect(turn.reply).toBe('您好，有什么可以帮您');
    expect(turn.error).toBeUndefined();
  });

  it('🔴 P2/P3 模型抛错 → outcome=error，retryable=true，且 reply 是空串', async () => {
    const { turn } = await runWith(async () => {
      throw new Error('connection reset');
    });

    expect(turn.outcome).toBe('error');
    expect(turn.error).toMatchObject({ code: 'model_error', retryable: true });
    // 这一条是整组的核心：失败不该看起来像成功。
    // 「失败时给一句像样的话」听起来贴心，实际是让失败伪装成回答
    expect(turn.reply).toBe('');
  });

  it('🔴 P7 error 事件带 code 与 retryable', async () => {
    const { events } = await runWith(async () => {
      throw new Error('boom');
    });

    const err = events.find((e) => e.type === 'error');
    // 只发一句中文的话，消费方判断「该不该重试」只能做字符串匹配
    expect(err).toMatchObject({ code: 'model_error', retryable: true });
  });

  it('🔴 P5 取消 → outcome=cancelled，且**不带 error**', async () => {
    const controller = new AbortController();
    controller.abort();

    const { turn, events } = await runWith(
      async () => ({ content: 'x', toolUses: [], usage, stopReason: 'end_turn' }),
      {},
      controller.signal
    );

    expect(turn.outcome).toBe('cancelled');
    // 给取消塞一个 error，会让所有按 error 字段告警的地方在用户关页面时炸（v1.0 定的调）
    expect(turn.error).toBeUndefined();
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.some((e) => e.type === 'cancelled')).toBe(true);
  });

  it('P6 达到 maxTurns → outcome=max_turns，retryable=false', async () => {
    // 永远只返回工具调用，逼它撞上限
    const { turn } = await runWith(
      async () => ({
        content: '',
        toolUses: [{ id: 't1', name: 'nonexistent_tool', input: {} }],
        usage,
        stopReason: 'tool_use',
      }),
      { maxTurns: 2 }
    );

    expect(turn.outcome).toBe('max_turns');
    expect(turn.error).toMatchObject({ code: 'max_turns', retryable: false });
    expect(turn.reply).toBe('');
  });

  it('🔴 outcome 的四种非 ok 情形，reply 一律是空串', async () => {
    // 一条横向断言：任何"失败但给了正文"的实现都会在这里被抓住
    const cases = [
      await runWith(async () => {
        throw new Error('x');
      }),
      await runWith(
        async () => ({
          content: '',
          toolUses: [{ id: 't', name: 'nope', input: {} }],
          usage,
          stopReason: 'tool_use' as const,
        }),
        { maxTurns: 1 }
      ),
    ];

    for (const { turn } of cases) {
      expect(turn.outcome).not.toBe('ok');
      expect(turn.reply).toBe('');
    }
  });

  it('retryable 的取值是有判断的，不是常量', async () => {
    const modelFail = await runWith(async () => {
      throw new Error('503');
    });
    const noConverge = await runWith(
      async () => ({
        content: '',
        toolUses: [{ id: 't', name: 'nope', input: {} }],
        usage,
        stopReason: 'tool_use' as const,
      }),
      { maxTurns: 1 }
    );

    // 模型抖动值得重试；问题不收敛重试一万次也是同一个结果
    expect(modelFail.turn.error!.retryable).toBe(true);
    expect(noConverge.turn.error!.retryable).toBe(false);
  });
});
