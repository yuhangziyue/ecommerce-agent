import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import { openTestDb, truncateAll, makeTestStores } from '../store/helpers.js';
import { seedKey, clientFor, type TestKey, type TestClient } from './helpers.js';
import type { Database } from '../../src/store/types.js';
import type { Stores } from '../../src/store/index.js';
import type { AgentConfig, AgentTool, ChatProvider, ChatResponse } from '../../src/core/types.js';

/**
 * 会话独占（v1.2 · D-5）。
 *
 * 会话是**追加式**的，所以并发不会覆盖数据 —— 它造成的是更隐蔽的问题：
 * 两个请求各自 restore 一份快照、各自往同一条会话追加，消息顺序交错，
 * `tool_use` 与产生它的 `tool_result` 被别的消息隔开。
 * 而 v0.3 的投影逻辑对顺序敏感 —— 下一轮 restore 出来的历史直接是坏的。
 */

const usage = { inputTokens: 10, outputTokens: 5 };

/** 可以被测试卡住/放行的 provider —— 让"并发"是确定性的，而不是靠 sleep 碰运气 */
class GatedProvider implements ChatProvider {
  calls = 0;
  private gate: Promise<void> | null = null;
  private open!: () => void;
  /** 解析出来表示"第一个请求确实已经进到模型调用里了" */
  entered!: Promise<void>;
  private markEntered!: () => void;

  arm(): void {
    this.gate = new Promise((r) => (this.open = r));
    this.entered = new Promise((r) => (this.markEntered = r));
  }

  release(): void {
    this.open?.();
    this.gate = null;
  }

  /** 用例之间必须清干净 —— 上一条用例armed 但没触发的闸门会挂死下一条 */
  reset(): void {
    this.open?.();
    this.gate = null;
  }

  async chat(system: string, _m: never, _t: AgentTool[]): Promise<ChatResponse> {
    if (system.includes('意图识别模块')) {
      return { content: '无法判断', toolUses: [], usage, stopReason: 'end_turn' };
    }
    this.calls++;
    // **一次性闸门**：只卡住第一个进来的调用。
    // 不清空的话，P13 里"另一个会话"的请求也会被卡住 —— 而那条用例要证明的
    // 恰恰是它**不该**被挡（锁是按会话的，不是全局的）
    const gate = this.gate;
    if (gate) {
      this.gate = null;
      this.markEntered();
      await gate;
    }
    return { content: '好的', toolUses: [], usage, stopReason: 'end_turn' };
  }

  getModel(): string {
    return 'fake-model';
  }
}

const config: AgentConfig = {
  model: 'fake-model',
  maxTurns: 5,
  maxTokensPerSession: 100_000,
  systemPrompt: '测试助手',
  confirmHighRisk: true,
};

describe('会话独占锁', () => {
  let db: Database;
  let stores: Stores;
  let app: FastifyInstance;
  let provider: GatedProvider;
  let key: TestKey;
  let client: TestClient;

  beforeAll(async () => {
    db = await openTestDb();
    stores = await makeTestStores(db);
    provider = new GatedProvider();
    app = await buildApp({ stores, config, provider });
    client = clientFor(app, () => key);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
    provider.reset();
    provider.calls = 0;
    key = await seedKey(stores, { tenantId: 't_acme' });
  });

  /** 先建一个会话，返回它的 id */
  async function makeSession(): Promise<string> {
    const res = await client.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '你好' },
    });
    return res.json().session_id;
  }

  it('🔴 P10/P11 同一会话并发 → 第二个 409 session_busy，且零模型调用', async () => {
    const sid = await makeSession();
    provider.calls = 0;
    provider.arm();

    // 第一个请求进去后会卡在模型调用里，锁一直被它持有
    const first = client.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '第一句', session_id: sid },
    });
    await provider.entered;

    const second = await client.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '第二句', session_id: sid },
    });

    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('session_busy');
    // 被拒的那个**一次模型调用都不发生** —— 拦在业务之前才有意义
    expect(provider.calls).toBe(1);

    provider.release();
    expect((await first).statusCode).toBe(200);
  });

  it('🔴 P11b 被拒的请求不往会话里写任何 entry', async () => {
    const sid = await makeSession();
    const before = (
      await db.query<{ n: string }>(
        'SELECT count(*) AS n FROM session_entries WHERE session_id = $1',
        [sid]
      )
    ).rows[0].n;

    provider.arm();
    const first = client.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '第一句', session_id: sid },
    });
    await provider.entered;

    await client.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '第二句', session_id: sid },
    });

    // 第二个请求还没跑完第一个就被拒了，此刻它一条都不该写进去。
    // 写进去的话，消息顺序就已经被它插花了 —— 这正是这把锁要防的事
    const during = (
      await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM session_entries
          WHERE session_id = $1 AND data::text LIKE '%第二句%'`,
        [sid]
      )
    ).rows[0].n;
    expect(Number(during)).toBe(0);
    expect(Number(before)).toBeGreaterThan(0);

    provider.release();
    await first;
  });

  it('P12 第一个结束后，第二个重发能正常拿到锁', async () => {
    const sid = await makeSession();
    provider.arm();

    const first = client.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '第一句', session_id: sid },
    });
    await provider.entered;
    provider.release();
    await first;

    const retry = await client.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '第二句', session_id: sid },
    });
    expect(retry.statusCode).toBe(200);
  });

  it('🔴 P13 不同会话并发互不影响', async () => {
    const a = await makeSession();
    const b = await makeSession();
    provider.arm();

    const first = client.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: 'A 的话', session_id: a },
    });
    await provider.entered;

    // 锁是**按会话**的，不是全局的。做成全局锁等于把服务变成单线程
    const other = await client.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: 'B 的话', session_id: b },
    });
    expect(other.statusCode).toBe(200);

    provider.release();
    await first;
  });

  it('🔴 P15 请求异常结束时锁被释放，不是等 TTL', async () => {
    const sid = await makeSession();

    // 让模型抛错 —— 走的是 finally 释放路径
    const boom = new GatedProvider();
    boom.chat = async (system: string) => {
      if (system.includes('意图识别模块')) {
        return { content: '无法判断', toolUses: [], usage, stopReason: 'end_turn' };
      }
      throw new Error('模型炸了');
    };
    const brokenApp = await buildApp({ stores, config, provider: boom });
    await brokenApp.ready();

    const failed = await brokenApp.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '会失败的一句', session_id: sid },
      headers: key.headers,
    });
    expect(failed.statusCode).toBe(502);

    // 靠 TTL 兜底意味着一次异常会让这条会话罚站一分钟
    const after = await client.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '紧接着再问', session_id: sid },
    });
    expect(after.statusCode).toBe(200);
    await brokenApp.close();
  });

  it('🔴 P14 锁过期后可被抢占（进程崩了不该把会话永久钉死）', async () => {
    const sid = await makeSession();

    // 手工模拟「上一个持有者崩了，锁留在库里」：置一个已经过期的锁
    await db.query('UPDATE sessions SET turn_locked_until = $2 WHERE id = $1', [
      sid,
      new Date(Date.now() - 60_000).toISOString(),
    ]);

    const res = await client.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '过期后应当能拿到', session_id: sid },
    });
    expect(res.statusCode).toBe(200);
  });

  it('未过期的锁不会被抢占', async () => {
    const sid = await makeSession();
    await db.query('UPDATE sessions SET turn_locked_until = $2 WHERE id = $1', [
      sid,
      new Date(Date.now() + 60_000).toISOString(),
    ]);

    const res = await client.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '应该被拒', session_id: sid },
    });
    expect(res.statusCode).toBe(409);
  });

  it('SSE 端点同样受锁保护', async () => {
    const sid = await makeSession();
    await db.query('UPDATE sessions SET turn_locked_until = $2 WHERE id = $1', [
      sid,
      new Date(Date.now() + 60_000).toISOString(),
    ]);

    const res = await client.inject({
      method: 'POST',
      url: '/v1/chat',
      payload: { message: '流式也要拦', session_id: sid },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('session_busy');
  });
});
