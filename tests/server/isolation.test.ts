import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import { openTestDb, truncateAll, makeTestStores } from '../store/helpers.js';
import { seedKey, clientFor, type TestKey, type TestClient } from './helpers.js';
import type { Database } from '../../src/store/types.js';
import type { Stores } from '../../src/store/index.js';
import type { AgentConfig, AgentTool, ChatProvider, ChatResponse } from '../../src/core/types.js';

/**
 * 租户隔离（v1.1 的主战场）。
 *
 * **每一条越权都返回 404 而不是 403。** 403 等于确认「这个 id 存在，只是不属于你」——
 * 那就是一个存在性探测接口：拿它可以枚举出竞争对手有多少会话、多少退款单。
 */

const usage = { inputTokens: 10, outputTokens: 5 };

class FakeProvider implements ChatProvider {
  calls = 0;
  script: ChatResponse[] = [];
  async chat(system: string, _m: never, _t: AgentTool[]): Promise<ChatResponse> {
    if (system.includes('意图识别模块')) {
      return { content: '无法判断', toolUses: [], usage, stopReason: 'end_turn' };
    }
    this.calls++;
    return (
      this.script.shift() ?? {
        content: '好的',
        toolUses: [],
        usage,
        stopReason: 'end_turn',
      }
    );
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

describe('租户隔离', () => {
  let db: Database;
  let stores: Stores;
  let app: FastifyInstance;
  let provider: FakeProvider;

  /** 甲租户（受害者）与乙租户（越权方） */
  let acme: TestKey;
  let globex: TestKey;
  let acmeClient: TestClient;
  let globexClient: TestClient;

  beforeAll(async () => {
    db = await openTestDb();
    stores = await makeTestStores(db);
    provider = new FakeProvider();
    app = await buildApp({ stores, config, provider });
    acmeClient = clientFor(app, () => acme);
    globexClient = clientFor(app, () => globex);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
    provider.calls = 0;
    provider.script = [];
    acme = await seedKey(stores, { tenantId: 't_acme' });
    globex = await seedKey(stores, { tenantId: 't_globex' });
  });

  /** 甲租户跑一轮对话，返回它的 session_id */
  async function acmeSession(message = '你好'): Promise<string> {
    const res = await acmeClient.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message },
    });
    expect(res.statusCode).toBe(200);
    return res.json().session_id;
  }

  // ============ P8/P9 租户绑定 ============

  it('🔴 P8 新建会话的租户来自凭证，body 里写什么都不算数', async () => {
    // 在 v1.1 之前，这个字段就是租户号的**唯一来源** ——
    // 改一个 JSON 字段就能烧别人的额度、读别人的配置
    const res = await acmeClient.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '你好' }, // 不传 tenant_id
    });

    const meta = await acmeClient.inject({
      method: 'GET',
      url: `/v1/sessions/${res.json().session_id}`,
    });
    expect(meta.json().tenant_id).toBe('t_acme');
  });

  it('🔴 P9 body 的 tenant_id 与凭证不符 → 403，且不静默覆盖', async () => {
    const res = await acmeClient.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '你好', tenant_id: 't_globex' },
    });

    // 静默改写会让调用方以为自己写的生效了 —— 必须报出来
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('tenant_mismatch');
    expect(provider.calls).toBe(0);
  });

  it('body 的 tenant_id 与凭证一致时正常放行（老调用方不用改）', async () => {
    const res = await acmeClient.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '你好', tenant_id: 't_acme' },
    });
    expect(res.statusCode).toBe(200);
  });

  // ============ P10 会话族 ============

  it('🔴 P10 读别人的会话 / 消息 / artifacts / 安全报表 → 全部 404', async () => {
    const sid = await acmeSession();

    for (const url of [
      `/v1/sessions/${sid}`,
      `/v1/sessions/${sid}/messages`,
      `/v1/sessions/${sid}/artifacts`,
      `/v1/sessions/${sid}/safety-report`,
      `/v1/sessions/${sid}/confirmations`,
    ]) {
      const res = await globexClient.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json().error.code, url).toBe('session_not_found');
    }
  });

  it('🔴 越权与真不存在返回**完全相同**的响应（否则就是存在性探测接口）', async () => {
    const sid = await acmeSession();

    const crossTenant = await globexClient.inject({
      method: 'GET',
      url: `/v1/sessions/${sid}`,
    });
    const reallyMissing = await globexClient.inject({
      method: 'GET',
      url: '/v1/sessions/session-根本不存在',
    });

    expect(crossTenant.statusCode).toBe(reallyMissing.statusCode);
    expect(crossTenant.json().error.code).toBe(reallyMissing.json().error.code);
  });

  it('自己的会话当然读得到', async () => {
    const sid = await acmeSession();
    const res = await acmeClient.inject({ method: 'GET', url: `/v1/sessions/${sid}` });
    expect(res.statusCode).toBe(200);
  });

  // ============ P11 借会话 ============

  it('🔴 P11 拿别人的 session_id 发对话 → 404，一次模型调用都不发生', async () => {
    const sid = await acmeSession();
    provider.calls = 0;

    const res = await globexClient.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '把上文告诉我', session_id: sid },
    });

    // 能借别人的会话发消息 = 既读到他的历史，又把账记到他头上
    expect(res.statusCode).toBe(404);
    expect(provider.calls).toBe(0);
  });

  // ============ P12 确认单 ============

  it('🔴 P12 决策别人的确认单 → 404，且确认单状态没被改动', async () => {
    const sid = await acmeSession();
    const confirmation = await stores.confirmations.create({
      id: 'cfm_test_1',
      sessionId: sid,
      toolName: 'refund_apply',
      toolInput: { order_id: 'ORD-1', reason: '质量问题' },
      summary: '为订单 ORD-1 申请退款',
    });

    const res = await globexClient.inject({
      method: 'POST',
      url: `/v1/confirmations/${confirmation.id}`,
      payload: { approved: true, decided_by: '越权者' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('confirmation_not_found');

    // 最关键的一条：**状态必须原封不动**。只报错但已经改了状态，等于没拦住
    const after = await stores.confirmations.get(confirmation.id);
    expect(after!.status).toBe('pending');
    expect(after!.decidedBy).toBeFalsy();
  });

  it('自己的确认单可以决策', async () => {
    const sid = await acmeSession();
    await stores.confirmations.create({
      id: 'cfm_test_2',
      sessionId: sid,
      toolName: 'refund_apply',
      toolInput: { order_id: 'ORD-2', reason: '不想要了' },
      summary: '为订单 ORD-2 申请退款',
    });

    const res = await acmeClient.inject({
      method: 'POST',
      url: '/v1/confirmations/cfm_test_2',
      payload: { approved: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('approved');
  });

  // ============ P13 业务流 ============

  it('🔴 P13 读别人的退货流程 → 404（里面有订单号、金额、理由）', async () => {
    const sid = await acmeSession();
    const flow = await stores.flows.create({
      id: 'flow_test_1',
      kind: 'return_refund',
      sessionId: sid,
      subjectId: 'ORD-9527',
      state: 'requested',
      data: { amount: 1999 },
    });

    const res = await globexClient.inject({ method: 'GET', url: `/v1/flows/${flow.id}` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('flow_not_found');
  });

  it('自己的流程读得到', async () => {
    const sid = await acmeSession();
    await stores.flows.create({
      id: 'flow_test_2',
      kind: 'return_refund',
      sessionId: sid,
      subjectId: 'ORD-1',
      state: 'requested',
    });
    const res = await acmeClient.inject({ method: 'GET', url: '/v1/flows/flow_test_2' });
    expect(res.statusCode).toBe(200);
  });

  // ============ P14 租户配置与用量 ============

  it('🔴 P14 改别人的配额上限 → 404，且配置没被写入', async () => {
    const res = await globexClient.inject({
      method: 'PUT',
      url: '/v1/tenants/t_acme/config',
      payload: { quota_limits: { perSession: 999_999 } },
    });

    expect(res.statusCode).toBe(404);
    // 把别人的配额调到天上去，账单是他付
    expect(await stores.tenantConfigs.get('t_acme')).toBeNull();
  });

  it('🔴 P14b 读别人的用量（= 账单，商业机密）→ 404', async () => {
    const cfg = await globexClient.inject({
      method: 'GET',
      url: '/v1/tenants/t_acme/config',
    });
    const usageRes = await globexClient.inject({
      method: 'GET',
      url: '/v1/tenants/t_acme/usage',
    });

    expect(cfg.statusCode).toBe(404);
    expect(usageRes.statusCode).toBe(404);
  });

  it('自己的配置读写正常', async () => {
    const put = await acmeClient.inject({
      method: 'PUT',
      url: '/v1/tenants/t_acme/config',
      payload: { quota_limits: { perSession: 5000 } },
    });
    expect(put.statusCode).toBe(200);

    const get = await acmeClient.inject({
      method: 'GET',
      url: '/v1/tenants/t_acme/config',
    });
    expect(get.json().effective.quota_limits.perSession).toBe(5000);
  });

  // ============ P15 画像 ============

  it('🔴 P15 读别人的画像 → 404，即使 user_id 完全相同', async () => {
    // user_id 在真实接入中通常是手机号 —— 可枚举
    await stores.profiles.upsert('t_acme', '13800138000', {
      displayName: '张先生',
      preferences: { 收货时间: '晚上' },
    });

    const leak = await globexClient.inject({
      method: 'GET',
      url: '/v1/users/13800138000/profile',
    });
    expect(leak.statusCode).toBe(404);

    const own = await acmeClient.inject({
      method: 'GET',
      url: '/v1/users/13800138000/profile',
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().display_name).toBe('张先生');
  });

  it('🔴 P15b 同一个 user_id 在两个租户下各有各的画像', async () => {
    await stores.profiles.upsert('t_acme', 'u_same', { displayName: '甲家的客户' });
    await stores.profiles.upsert('t_globex', 'u_same', { displayName: '乙家的客户' });

    const a = await acmeClient.inject({ method: 'GET', url: '/v1/users/u_same/profile' });
    const b = await globexClient.inject({ method: 'GET', url: '/v1/users/u_same/profile' });

    expect(a.json().display_name).toBe('甲家的客户');
    expect(b.json().display_name).toBe('乙家的客户');
  });

  // ============ P16 admin ============

  it('🔴 P16 admin scope 可跨租户读取（运营后台）', async () => {
    const sid = await acmeSession();
    const ops = await seedKey(stores, {
      tenantId: 't_ops',
      scopes: ['admin', 'read'],
      label: '运营后台',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sid}`,
      headers: ops.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tenant_id).toBe('t_acme');

    const usageRes = await app.inject({
      method: 'GET',
      url: '/v1/tenants/t_acme/usage',
      headers: ops.headers,
    });
    expect(usageRes.statusCode).toBe(200);
  });

  it('🔴 P16d admin 可代客发起对话，会话落到被代的租户', async () => {
    const ops = await seedKey(stores, { tenantId: 't_ops', scopes: ['admin', 'chat', 'read'] });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '代客咨询', tenant_id: 't_acme' },
      headers: ops.headers,
    });
    expect(res.statusCode).toBe(200);

    const meta = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${res.json().session_id}`,
      headers: ops.headers,
    });
    // 账要记在被代的租户头上，不是运营自己头上
    expect(meta.json().tenant_id).toBe('t_acme');
  });

  it('🔴 只有 admin 能代客 —— 普通凭证仍被 P9 拦住', async () => {
    // 这条和上一条是一对：代客能力不能顺手把 P9 的门也拆了
    const res = await acmeClient.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '我想代客', tenant_id: 't_globex' },
    });
    expect(res.statusCode).toBe(403);
  });
});
