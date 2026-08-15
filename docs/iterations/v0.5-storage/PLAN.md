# v0.5 存储层 · 实现计划

**Goal:** 把会话持久化从 JSONL 文件搬到 PostgreSQL，为 v0.6 服务化扫清「并发写入」「按用户查询」「单机绑定」三个障碍。

**Architecture:** `Database`（引擎抽象：PGlite 本地 / pg 驱动生产）→ `PgSessionStore` / `PgRefundStore`（唯一实现，写标准 SQL）→ 业务代码只认接口。测试直接打真 SQL，不写内存 Mock（避免 mock 漂移）。

**Tech Stack:** `@electric-sql/pglite`（PostgreSQL 18.3 WASM，实测可用）· `pg`（生产驱动）· vitest

**Spec:** `docs/iterations/v0.5-storage/SPEC.md`

## Global Constraints

- 用例基线 **202**，不得净减；`npm run verify` 必须 exit 0
- 无 `DATABASE_URL` 时零配置可跑（PGlite 落 `.data/`，加进 `.gitignore`）
- **测试不得每个用例新建 PGlite 实例**（实测创建耗时 450–780ms）：每个测试文件 `beforeAll` 建一次，`beforeEach` TRUNCATE
- `pg` 只在 `PgPoolDatabase` 内 import，不进默认路径
- 每 Task 结束即提交，前缀 `feat(v0.5):` / `refactor(v0.5):`

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `src/store/types.ts` | `Database` / `SessionStore` / `RefundStore` 接口与记录类型 | 新建 |
| `src/store/database.ts` | `PGliteDatabase` / `PgPoolDatabase` / `createDatabase(url?)` | 新建 |
| `src/store/migrations.ts` | 迁移 SQL + 幂等执行器（`schema_migrations` 表） | 新建 |
| `src/store/pg-session-store.ts` | 会话与事件的 PG 实现 | 新建 |
| `src/store/pg-refund-store.ts` | `UNIQUE(order_id)` 真幂等 | 新建 |
| `src/store/index.ts` | barrel + `openStores(url?)` | 新建 |
| `src/core/session.ts` | 改为异步、走 `SessionStore`；保留 v0.3 的投影逻辑 | 重写 |
| `src/core/agent-loop.ts` | 6 处 session 调用加 `await` | 修改 |
| `src/tools/refund-store.ts` | 保留接口与进程内实现，新增「注入 PG 实现」的入口 | 修改 |
| `src/tools/refund-apply.ts` | 改为 `await store.createIfAbsent(...)` | 修改 |
| `src/memory/context-manager.ts` | 删除 `trimMessages` | 修改 |
| `src/index.ts` | 启动时开库、跑迁移、注入 store | 修改 |
| `.gitignore` | 加 `.data/` | 修改 |
| `tests/store/helpers.ts` | 共享 PGlite 实例 + TRUNCATE 隔离 | 新建 |
| `tests/store/migrate.test.ts` | 迁移幂等 | 新建 |
| `tests/store/session-store.test.ts` | 追加/读回/并发/按用户查询 | 新建 |
| `tests/store/refund-store.test.ts` | 并发幂等 | 新建 |
| `tests/session.test.ts` | 改写为异步 | 重写 |
| `tests/context-manager.test.ts` | 删除 `trimMessages` 的 6 条用例 | 修改 |

---

## Task 1: Database 引擎抽象 + 迁移

**Produces:**
```ts
export interface QueryResult<R = Record<string, unknown>> { rows: R[] }
export interface Database {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<R>>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  readonly engine: 'pglite' | 'pg';
}
export function createDatabase(url?: string): Promise<Database>;   // url 缺省 → PGlite
export function runMigrations(db: Database): Promise<string[]>;    // 返回本次实际执行的迁移名
```

迁移 `001_init`：
```sql
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT,
  tenant_id    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_sessions_user   ON sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON sessions (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS session_entries (
  seq        BIGSERIAL PRIMARY KEY,          -- 追加顺序的唯一真相，不依赖时间戳
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  data       JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_entries_session ON session_entries (session_id, seq);

CREATE TABLE IF NOT EXISTS refund_tickets (
  refund_id  TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL UNIQUE,           -- 幂等的真实执行者
  amount     NUMERIC(12,2) NOT NULL,
  reason     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

> `seq BIGSERIAL` 是排序依据 —— **不用 `created_at`**：并发写入下时间戳可能相同，
> 而 v0.3 的投影逻辑对顺序敏感（tool_result 必须跟在对应的 assistant 之后）。

- [ ] Step 1: 写 `tests/store/migrate.test.ts`（跑两次幂等；第二次返回空数组；表存在）
- [ ] Step 2: 红 → 实现 → 绿
- [ ] Step 3: 提交 `feat(v0.5): Database 引擎抽象与迁移机制`

---

## Task 2: PgSessionStore

**Produces:**
```ts
export interface SessionRecord { id: string; userId: string | null; tenantId: string | null; createdAt: number; updatedAt: number; metadata: Record<string, unknown> }
export interface SessionStore {
  create(input?: { id?: string; userId?: string; tenantId?: string; metadata?: Record<string, unknown> }): Promise<SessionRecord>;
  get(id: string): Promise<SessionRecord | null>;
  listByUser(userId: string, limit?: number): Promise<SessionRecord[]>;
  listByTenant(tenantId: string, limit?: number): Promise<SessionRecord[]>;
  appendEntry(sessionId: string, entry: SessionEntry): Promise<void>;
  getEntries(sessionId: string): Promise<SessionEntry[]>;
}
```

- [ ] Step 1: 写 `tests/store/session-store.test.ts`
      —— 追加后按序读回；**并发 `Promise.all` 追加 50 条不丢不乱序**；按 user/tenant 倒序列出；不存在返回 null
- [ ] Step 2: 红 → 实现 → 绿
- [ ] Step 3: 提交 `feat(v0.5): PgSessionStore（含并发追加与按用户/租户查询）`

---

## Task 3: Session 改异步 + AgentLoop 适配

`Session` 保留现有语义（`getMessages()` 的 v0.3 投影逻辑原样搬），但：
- `Session.create()` / `restore()` → 静态异步工厂，接受 `SessionStore`
- `appendMessage` / `appendToolCall` / `appendToolResult` / `appendMetadata` → `Promise<void>`
- `getMessages()` / `getEntries()` → 内存缓存 + 异步 `load()`（Loop 里高频读，不能每次打库）

- [ ] Step 1: 重写 `tests/session.test.ts` 为异步（原 9 + v0.3 的 6 条性质全部保留）
- [ ] Step 2: 红 → 重写 `Session` → 绿
- [ ] Step 3: `AgentLoop` 6 处调用加 `await`；跑 `agent-loop.test.ts` 确认 32 条不碰红
- [ ] Step 4: 提交 `refactor(v0.5): Session 改为异步并走 SessionStore`

---

## Task 4: 退款真幂等 + 删 trimMessages

- [ ] Step 1: 写 `tests/store/refund-store.test.ts` —— **并发 10 次申请同一订单只建 1 单**
      （`INSERT ... ON CONFLICT (order_id) DO NOTHING` + 回查）
- [ ] Step 2: 红 → 实现 `PgRefundStore` → 绿
- [ ] Step 3: `refund-apply.ts` 改 `await`；`tests/refund-apply.test.ts` 注入 PG 实现
- [ ] Step 4: 删 `ContextManager.trimMessages` 与其 6 条用例；`grep -c trimMessages src/` → 0
- [ ] Step 5: 提交 `feat(v0.5): 退款 UNIQUE(order_id) 真幂等 + 删除旧盲切裁剪`

---

## Task 5: 装配与验收

- [ ] Step 1: `src/index.ts` 启动时 `openStores(process.env.DATABASE_URL)` + 跑迁移 + 注入
- [ ] Step 2: `.gitignore` 加 `.data/`
- [ ] Step 3: 逐条核 D1–D10
- [ ] Step 4: 红-绿验证 —— 把 `session_entries` 的排序从 `seq` 改成 `created_at`，
      确认并发顺序用例变红（证明 `seq` 是必要的而非装饰）
- [ ] Step 5: `REPORT.md` + ROADMAP 进度 + tag `v0.5` + 推送

## Self-Review

**Spec 覆盖**：9 项 → Task 1(1,2,9) / Task 2(3,5) / Task 3(4) / Task 4(6,8) / Task 5(装配)。
第 7 项（并发安全验证）落在 Task 2 Step 1。无遗漏。
**占位符**：各 Task Step 1 给了断言目标而非完整代码；SQL 与接口签名是完整的，实现时不接受降级。
**类型一致性**：`Database` 在 Task 1 定义、Task 2/4 使用；`SessionStore` 在 Task 2 定义、Task 3 使用；
`SessionEntry` 复用 `src/core/types.ts` 既有定义，不新造。已核对。
