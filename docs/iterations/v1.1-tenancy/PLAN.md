# v1.1 实施计划

> 对应 [SPEC.md](SPEC.md)。**先红后绿，每步跑命令验证。**

---

## 一、文件清单

### 新建

| 文件 | 内容 | 产出 |
|---|---|---|
| `src/auth/types.ts` | `Principal` / `Scope` / `ApiKeyRecord` / `ApiKeyStore` | 类型 |
| `src/auth/api-key.ts` | `generateApiKey()` / `hashApiKey()` / `parseBearer()` | 纯函数，可单测 |
| `src/store/pg-api-key-store.ts` | 按哈希查、签发、吊销 | `ApiKeyStore` 实现 |
| `src/store/pg-idempotency-store.ts` | 占位/回填/查询 | `IdempotencyStore` 实现 |
| `src/server/auth.ts` | `authenticate` preHandler + `ownsTenant` / `assertOwnSession` | Fastify 接线 |
| `src/server/rate-limit.ts` | `RateLimiter`（Redis 固定窗口 / 进程内令牌桶） | 可注入时钟 |
| `src/server/idempotency.ts` | `withIdempotency(...)` 包装器 | JSON 端点用 |
| `scripts/issue-key.ts` | `npm run key:issue -- --tenant t1 --scopes chat,read` | CLI |
| `tests/server/helpers.ts` | `seedKey()` + `clientFor()`（注入 Authorization 的 inject 包装） | 测试基建 |

### 修改

| 文件 | 改什么 |
|---|---|
| `src/store/migrations.ts` | +`008_api_keys` +`009_idempotency` +`010_profiles_tenant` |
| `src/store/types.ts` | `ProfileStore` 全部方法加 `tenantId` |
| `src/store/pg-profile-store.ts` | 按 `(tenant_id, user_id)` 读写 |
| `src/store/index.ts` | `Stores` 加 `apiKeys` / `idempotency` |
| `src/middleware/profile.mw.ts` | 传租户 |
| `src/memory/user-profile.ts` | 内存实现同步改 |
| `src/server/app.ts` | 挂 preHandler；`tenantId` 只从 principal 取；**16 个端点逐个加归属校验** |
| `src/server.ts` | 启动时打印认证状态；`AGENT_AUTH_DISABLED` 警告 |
| `package.json` | `key:issue` 脚本 |
| 既有 7 个 server 测试文件 | 走 `clientFor()` 带凭证 |

## 二、关键接口

```ts
// src/auth/types.ts
export type Scope = 'chat' | 'read' | 'write' | 'admin';

export interface Principal {
  keyId: string;
  tenantId: string;
  scopes: Scope[];
  /** 认证被显式关闭时为 true —— 让日志/指标能把这类请求分出来 */
  anonymous?: boolean;
}

export interface ApiKeyStore {
  /** 只按哈希查。明文永不落库 */
  findByHash(hash: string): Promise<ApiKeyRecord | null>;
  issue(input: { tenantId: string; scopes: Scope[]; label?: string }):
    Promise<{ record: ApiKeyRecord; plaintext: string }>;
  revoke(keyId: string): Promise<boolean>;
  listByTenant(tenantId: string): Promise<ApiKeyRecord[]>;
}
```

```ts
// src/server/idempotency.ts
type Outcome = { status: number; body: unknown };
withIdempotency(store, principal, key, requestHash, fn: () => Promise<Outcome>): Promise<Outcome>
```

## 三、TDD 步骤

> 每步：**写测试 → 跑（必须红）→ 实现 → 跑（必须绿）**。
> 标 🔌 的步骤结束后要做**断电验证**：撤掉修复，确认对应用例转红。

| # | 步骤 | 验证命令 |
|---|---|---|
| 1 | `hashApiKey` / `generateApiKey` / `parseBearer` 纯函数 | `vitest run tests/auth` |
| 2 | 迁移 008/009/010 + `ApiKeyStore` / `IdempotencyStore` 库级用例 | `vitest run tests/store` |
| 3 | 🔌 画像按租户隔离（P15/P15b）—— **先写跨租户读到别人画像的用例，它现在应该是绿的（洞存在），改完必须红→绿** | `vitest run tests/memory tests/store` |
| 4 | 🔌 `authenticate` preHandler（P1–P7） | `vitest run tests/server/auth` |
| 5 | 🔌 租户绑定 + 16 端点归属校验（P8–P16） | `vitest run tests/server/isolation` |
| 6 | 限流（P17–P19） | `vitest run tests/server/rate-limit` |
| 7 | 🔌 幂等（P20–P24） | `vitest run tests/server/idempotency` |
| 8 | 既有 7 个测试文件接凭证 | `npm test` |
| 9 | 全量回归 + 评测门 | `npm run verify && npm run eval` |

### 第 3 步的写法（关键）

这一步不是"加个测试"，是**先把洞固定成用例**：

```ts
it('🔴 租户 B 读不到租户 A 同名 user 的画像', async () => {
  await profiles.upsert('t_a', 'u_same', { displayName: '张先生' });
  expect(await profiles.get('t_b', 'u_same')).toBeNull();   // 改之前：拿到"张先生"
});
```

**改之前跑一次，必须看到它失败**（因为现在的签名根本没有租户参数 —— 类型就过不了，
这正是"数据模型缺一维"的证据）。

## 四、风险预判

| 风险 | 处置 |
|---|---|
| **默认开启认证会让所有既有 server 用例转红** | 这是**期望行为**。用 `clientFor()` 统一接凭证，不给 buildApp 加"测试模式绕过" —— 那等于测的不是生产路径 |
| 归属校验漏一个端点 | 用例按端点逐条列（P10–P16 共 7 组），并在 REPORT 里贴出**全部受保护端点的清单**逐个对照 |
| 确认单/流程没有 tenant 字段 | 走 session 反查租户（租户归属的唯一真相在 session 上）。多一次查询，换的是不引入第二处租户来源 |
| 进程内限流在多实例下失准 | 已在 SPEC 写明；`/healthz` 暴露 `rate_limit: 'redis' \| 'in-process'`，运维看得见 |
| 幂等占位后进程崩溃 → key 永久卡在 in_progress | 记录带 `expires_at`，超时视为未占位。**不做分布式锁** —— 代价不值得，冲突窗口只有单次请求时长 |
| `truncateAll` 已改为查 `pg_tables`，新表自动纳入 | 无需改动（v0.11 的教训已经还过了） |

## 五、不改的东西

- `AgentLoop` / `Pipeline` / 工具层 **一行不改**。身份是入口层的事，
  loop 只该知道 `ToolContext` 里的 tenantId 从哪来 —— 而它已经从 session 拿了。
- 现有错误体形状 `{error:{code,message}}` 沿用，不新增错误协议。
