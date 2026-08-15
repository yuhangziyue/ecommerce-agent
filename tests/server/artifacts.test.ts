import { buildApp } from '../../src/server/app.js';
import { openTestDb, truncateAll, makeTestStores } from '../store/helpers.js';
import { resolveSafetyRules, CachedTenantConfig } from '../../src/tenants/config.js';
import { INPUT_RULES } from '../../src/safety/rules.js';
import { PgTenantConfigStore } from '../../src/store/pg-tenant-config-store.js';
import type { Database } from '../../src/store/types.js';
import type { Stores } from '../../src/store/index.js';
import type {
  AgentConfig,
  AgentTool,
  ChatProvider,
  ChatResponse,
} from '../../src/core/types.js';
import type { FastifyInstance } from 'fastify';

const usage = { inputTokens: 10, outputTokens: 5 };

class ToolProvider implements ChatProvider {
  /** 可改的回复文案 —— 用来验证「模型换说法不影响 artifact」 */
  replyText = '为您找到以下商品';

  constructor(
    private readonly toolName: string,
    private readonly input: Record<string, unknown>
  ) {}

  async chat(system: string, messages: any[], _t: AgentTool[]): Promise<ChatResponse> {
    if (system.includes('意图识别模块')) {
      return { content: '无法判断', toolUses: [], usage, stopReason: 'end_turn' };
    }
    const last = messages[messages.length - 1];
    if (last?.role === 'tool') {
      return { content: this.replyText, toolUses: [], usage, stopReason: 'end_turn' };
    }
    return {
      content: '',
      toolUses: [{ id: 't1', name: this.toolName, input: this.input }],
      usage,
      stopReason: 'tool_use',
    };
  }

  getModel(): string {
    return 'fake-model';
  }
}

const config: AgentConfig = {
  model: 'claude-sonnet-5',
  apiKey: 'test',
  maxTurns: 3,
  maxTokensPerSession: 1_000_000,
  systemPrompt: '你是客服助手',
  confirmHighRisk: true,
};

function parseSse(body: string): Array<[string, any]> {
  return body
    .split('\n\n')
    .filter((b) => b.trim())
    .map((b) => {
      const e = b.split('\n').find((l) => l.startsWith('event: '))!;
      const d = b.split('\n').find((l) => l.startsWith('data: '))!;
      return [e.slice(7), JSON.parse(d.slice(6))] as [string, any];
    });
}

describe('结构化数据贯通到 API 表面', () => {
  let db: Database;
  let stores: Stores;
  let app: FastifyInstance;
  let provider: ToolProvider;

  beforeAll(async () => {
    db = await openTestDb();
  });
  afterAll(async () => db.close());
  beforeEach(async () => {
    await truncateAll(db);
    stores = await makeTestStores(db);
    provider = new ToolProvider('product_search', { category: '电子产品' });
    app = await buildApp({ stores, config, provider });
  });
  afterEach(async () => app.close());

  it('🔴 /v1/chat/sync 返回 artifacts，调用方不必解析 reply 里的中文', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/sync',
      payload: { message: '有什么电子产品' },
    });

    const body = JSON.parse(res.body);
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0].type).toBe('product_list');
    expect(body.artifacts[0].data.products.length).toBeGreaterThan(0);
    expect(typeof body.artifacts[0].data.products[0].price).toBe('number');
  });

  it('🔴 模型换个说法，artifact 一个字节都不变（这就是它不经过模型的意义）', async () => {
    provider.replyText = '为您找到以下商品';
    const a = JSON.parse(
      (await app.inject({
        method: 'POST',
        url: '/v1/chat/sync',
        payload: { message: '有什么电子产品' },
      })).body
    );

    provider.replyText = '亲，这几款都不错哦～售价￥两百九十九起';
    const b = JSON.parse(
      (await app.inject({
        method: 'POST',
        url: '/v1/chat/sync',
        payload: { message: '有什么电子产品' },
      })).body
    );

    expect(a.reply).not.toBe(b.reply); // 文案确实变了
    expect(b.artifacts[0].data).toEqual(a.artifacts[0].data); // 结构化数据没变
  });

  it('🔴 SSE 出现独立的 artifact 事件', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      payload: { message: '有什么电子产品' },
    });

    const event = parseSse(res.body).find((e) => e[0] === 'artifact');
    expect(event).toBeDefined();
    expect(event![1].type).toBe('product_list');
    expect(event![1].tool).toBe('product_search');
    expect(event![1].data.products.length).toBeGreaterThan(0);
  });

  it('tool_end 上也挂一份，省得客户端订阅两个事件', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      payload: { message: '有什么电子产品' },
    });

    const toolEnd = parseSse(res.body).find((e) => e[0] === 'tool_end');
    expect(toolEnd![1].artifact.type).toBe('product_list');
  });

  it('无 artifact 的工具，tool_end 的 artifact 为 null 而不是缺字段', async () => {
    const app2 = await buildApp({
      stores,
      config,
      provider: new ToolProvider('faq_search', { query: '退货' }),
    });
    const res = await app2.inject({
      method: 'POST',
      url: '/v1/chat',
      payload: { message: '怎么退货' },
    });

    const toolEnd = parseSse(res.body).find((e) => e[0] === 'tool_end');
    expect(toolEnd![1]).toHaveProperty('artifact');
    expect(toolEnd![1].artifact).toBeNull();
    await app2.close();
  });

  it('🔴 /v1/sessions/:id/artifacts 可回放（断线重连不必重跑对话）', async () => {
    const { session_id } = JSON.parse(
      (await app.inject({
        method: 'POST',
        url: '/v1/chat/sync',
        payload: { message: '有什么电子产品' },
      })).body
    );

    const res = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${session_id}/artifacts`,
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0].type).toBe('product_list');
    expect(body.artifacts[0].tool_use_id).toBeTruthy();
  });

  it('回放不存在的会话 → 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/sessions/sesn_nope/artifacts',
    });
    expect(res.statusCode).toBe(404);
  });

  it('没有产出 artifact 的会话回放返回空数组而不是报错', async () => {
    const app2 = await buildApp({
      stores,
      config,
      provider: new ToolProvider('faq_search', { query: '退货' }),
    });
    const { session_id } = JSON.parse(
      (await app2.inject({
        method: 'POST',
        url: '/v1/chat/sync',
        payload: { message: '怎么退货' },
      })).body
    );

    const body = JSON.parse(
      (await app2.inject({ method: 'GET', url: `/v1/sessions/${session_id}/artifacts` }))
        .body
    );
    expect(body.artifacts).toEqual([]);
    await app2.close();
  });
});

describe('租户配置（还 v0.10 / v0.12 的账）', () => {
  let db: Database;
  let stores: Stores;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await openTestDb();
  });
  afterAll(async () => db.close());
  beforeEach(async () => {
    await truncateAll(db);
    stores = await makeTestStores(db);
    app = await buildApp({
      stores,
      config,
      provider: new ToolProvider('product_search', {}),
      quotaLimits: { perSession: 100_000, perTenant: 0 },
    });
  });
  afterEach(async () => app.close());

  it('未配置租户时用默认值，行为与本版之前一致', async () => {
    const body = JSON.parse(
      (await app.inject({ method: 'GET', url: '/v1/tenants/t_new/config' })).body
    );
    expect(body.configured).toBe(false);
    expect(body.effective.quota_limits.perSession).toBe(100_000);
    expect(body.effective.return_policy.windowDays).toBe(7);
  });

  it('🔴 租户可配自己的售后政策与配额', async () => {
    await app.inject({
      method: 'PUT',
      url: '/v1/tenants/t_vip/config',
      payload: {
        return_policy: { windowDays: 30, autoApproveAmount: 5000 },
        quota_limits: { perSession: 999_999 },
      },
    });

    const body = JSON.parse(
      (await app.inject({ method: 'GET', url: '/v1/tenants/t_vip/config' })).body
    );
    expect(body.configured).toBe(true);
    expect(body.effective.return_policy.windowDays).toBe(30);
    expect(body.effective.quota_limits.perSession).toBe(999_999);
    // 没配的字段沿用默认
    expect(body.effective.quota_limits.perTenant).toBe(0);
  });

  it('🔴 不同租户互不影响', async () => {
    await app.inject({
      method: 'PUT',
      url: '/v1/tenants/t_a/config',
      payload: { return_policy: { windowDays: 30 } },
    });

    const b = JSON.parse(
      (await app.inject({ method: 'GET', url: '/v1/tenants/t_b/config' })).body
    );
    expect(b.effective.return_policy.windowDays).toBe(7);
  });

  it('配置改完立即生效（缓存写入即失效，不需要等 TTL）', async () => {
    await app.inject({
      method: 'GET',
      url: '/v1/tenants/t_x/config',
    }); // 先读一次，把 null 塞进缓存

    await app.inject({
      method: 'PUT',
      url: '/v1/tenants/t_x/config',
      payload: { return_policy: { windowDays: 99 } },
    });

    const body = JSON.parse(
      (await app.inject({ method: 'GET', url: '/v1/tenants/t_x/config' })).body
    );
    expect(body.effective.return_policy.windowDays).toBe(99);
  });

  it('未知字段被拒（400），不静默丢弃', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/tenants/t_y/config',
      payload: { returnPolicy: { windowDays: 30 } }, // 驼峰，应该是 return_policy
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('安全规则叠加 · 只能加严不能放宽', () => {
  const extra = {
    id: 'tenant.custom',
    name: '租户自定义词',
    pattern: /内部机密/,
    action: 'block' as const,
    reason: '命中租户自定义规则',
  };

  it('租户规则追加在全局规则之后', () => {
    const merged = resolveSafetyRules(INPUT_RULES, [extra]);
    expect(merged).toHaveLength(INPUT_RULES.length + 1);
    expect(merged.map((r) => r.id)).toContain('tenant.custom');
  });

  it('🔴 全局规则一条都不能少（放宽即安全洞）', () => {
    const merged = resolveSafetyRules(INPUT_RULES, [extra]);
    for (const g of INPUT_RULES) {
      expect(merged.find((r) => r.id === g.id)).toBe(g);
    }
  });

  it('🔴 同 id 的租户规则被忽略而不是覆盖（覆盖等价于允许放宽）', () => {
    const sneaky = {
      id: INPUT_RULES[0].id, // 冒充全局规则
      name: '伪装',
      pattern: /永不匹配的东西zzz/,
      action: 'mask' as const, // 把 block 降级成 mask
      replacement: '***',
    };

    const merged = resolveSafetyRules(INPUT_RULES, [sneaky]);
    const rule = merged.find((r) => r.id === INPUT_RULES[0].id)!;
    expect(rule.action).toBe(INPUT_RULES[0].action); // 仍然是原来的处置
    expect(rule).toBe(INPUT_RULES[0]);
    expect(merged).toHaveLength(INPUT_RULES.length);
  });

  it('没有租户规则时返回全局规则本身', () => {
    expect(resolveSafetyRules(INPUT_RULES)).toEqual(INPUT_RULES);
  });
});

describe('租户配置存储与缓存', () => {
  let db: Database;
  let store: PgTenantConfigStore;

  beforeAll(async () => {
    db = await openTestDb();
    store = new PgTenantConfigStore(db);
  });
  afterAll(async () => db.close());
  beforeEach(async () => truncateAll(db));

  it('🔴 正则能正确往返（直接存 RegExp 会静默变成 {} 且毫无报错）', async () => {
    await store.upsert({
      tenantId: 't_re',
      extraSafetyRules: {
        input: [
          {
            id: 'x',
            name: '测试',
            pattern: /敏感词\d+/i,
            action: 'block',
            reason: 'r',
          },
        ],
      },
    });

    const got = await store.get('t_re');
    const rule = got!.extraSafetyRules!.input![0];
    expect(rule.pattern).toBeInstanceOf(RegExp);
    expect(rule.pattern.source).toBe('敏感词\\d+');
    expect(rule.pattern.flags).toContain('i');
    expect(rule.pattern.test('敏感词123')).toBe(true);
  });

  it('upsert 覆盖同一租户而不是新建', async () => {
    await store.upsert({ tenantId: 't_up', returnPolicy: { windowDays: 10 } });
    await store.upsert({ tenantId: 't_up', returnPolicy: { windowDays: 20 } });

    expect((await store.get('t_up'))!.returnPolicy!.windowDays).toBe(20);
    expect(await store.list()).toHaveLength(1);
  });

  it('缓存命中不打库，写入后立即失效', async () => {
    let dbReads = 0;
    const counting = {
      get: async (id: string) => {
        dbReads++;
        return store.get(id);
      },
      upsert: (c: any) => store.upsert(c),
      list: (l?: number) => store.list(l),
    };
    const cached = new CachedTenantConfig(counting);

    await cached.get('t_c');
    await cached.get('t_c');
    await cached.get('t_c');
    expect(dbReads).toBe(1);

    await cached.upsert({ tenantId: 't_c', returnPolicy: { windowDays: 5 } });
    expect((await cached.get('t_c'))!.returnPolicy!.windowDays).toBe(5);
    expect(dbReads).toBe(1); // upsert 直接把新值放进缓存，不需要再读

    cached.invalidate('t_c');
    await cached.get('t_c');
    expect(dbReads).toBe(2);
  });

  it('无租户 id 时不查库直接返回 null', async () => {
    let reads = 0;
    const cached = new CachedTenantConfig({
      get: async (id: string) => {
        reads++;
        return store.get(id);
      },
      upsert: (c: any) => store.upsert(c),
      list: (l?: number) => store.list(l),
    });

    expect(await cached.get(null)).toBeNull();
    expect(await cached.get(undefined)).toBeNull();
    expect(reads).toBe(0);
  });
});
