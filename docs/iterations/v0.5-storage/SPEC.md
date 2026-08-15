# v0.5 · 存储层（Storage）

> 起点 `a244c0c`（v0.4）｜ 后继 v0.6 服务化
> **v0.6 服务化的硬前置**：服务化后会话不能再存进程内存与本地文件。

---

## 一、迭代目的

当前会话持久化是 `sessions/*.jsonl` + `appendFileSync`。这套东西在 CLI 单进程下能用，
到 v0.6 服务化就全线失效：

1. **无并发保护** —— 多个 HTTP 请求同时写同一会话，`appendFileSync` 交错写入会产生半行；
   `loadFromFile` 只能跳过损坏行（v0.2 就写了这个兜底），意味着**静默丢消息**
2. **无法按用户/租户查询** —— 文件名只有 sessionId。要回答「这个用户最近的会话」
   只能遍历全部文件逐个解析。v0.11 多租户计费要按租户聚合用量，这条路走不通
3. **单机绑定** —— 文件在本地磁盘，服务无法水平扩容
4. **退款幂等只在进程内** —— v0.3 明确写了「不宣称生产级幂等，重启即失效」

## 二、核心设计

### ⚙️ 设计① Store 接口族 + 单一 PG 实现，引擎可换

```
        SessionStore / RefundStore  ← 接口（业务代码只认这个）
                    │
              PgSessionStore        ← 唯一实现（写标准 SQL）
                    │
                 Database           ← 引擎抽象：query(sql, params)
                 ╱        ╲
          PGliteDatabase   PgPoolDatabase
          （本地/测试）      （生产，pg 驱动连真 PG）
```

**关键取舍：不写「内存实现」给测试用。**

常见做法是给测试写一套内存 Mock，但那会产生 **mock 漂移** —— 内存实现的行为
（尤其是唯一约束、事务、NULL 语义）与真 SQL 不同，测试全绿而生产炸。

PGlite 是**真正的 PostgreSQL 编译成 WASM**（实测 `PostgreSQL 18.3 (PGlite 0.5.5)`），
跑在进程内、零基础设施。所以测试直接打真 SQL，`UNIQUE` 约束、事务、`ON CONFLICT`
的行为与生产完全一致。**生产切真 PG 只改连接串。**

### ⚙️ 设计② Session 从「同步文件追加」改为「异步事件表」

`Session` 的写入 API 由同步改为异步（`await session.appendMessage(...)`）。
这是必要的破坏性变更 —— 数据库写入不可能同步，而**假装同步**（写behind队列）
会丢掉「写成功才返回」这个持久性保证，恰恰是 v0.6 服务化最需要的。

事件仍是**追加式**（event sourcing），只是从 JSONL 行变成 `session_entries` 表行。
`getMessages()` 的投影逻辑（v0.3 的成果）原样保留。

## 三、边界

### ✅ 本版做

| # | 事项 | 类型 |
|---|---|---|
| 1 | `Database` 引擎抽象 + `PGliteDatabase` + `PgPoolDatabase` | 设计① |
| 2 | 迁移机制（`migrations/*.sql` 顺序执行 + `schema_migrations` 表记录） | 设计① |
| 3 | `SessionStore` 接口 + `PgSessionStore`（含 `userId` / `tenantId` 字段与索引） | 设计① |
| 4 | `Session` 类改为异步、走 store；`AgentLoop` 相应 `await` | 设计② |
| 5 | 按用户/租户列会话（`listByUser` / `listByTenant`） | 🔧 缺陷 2 |
| 6 | `RefundStore` PG 实现：`UNIQUE(order_id)` + `ON CONFLICT DO NOTHING` 真幂等 | 🔧 承接 v0.3 |
| 7 | 并发写入安全性验证（并发追加不丢不乱序） | 🔧 缺陷 1 |
| 8 | 删除 `ContextManager.trimMessages`（旧盲切版，生产路径已全走 `trimSafely`） | 🔧 承接 v0.3 |
| 9 | 连接配置：`DATABASE_URL` 有值走真 PG，无值走 PGlite（默认落 `.data/`） | 设计① |

### ❌ 本版不做

| 事项 | 留给 | 理由 |
|---|---|---|
| Redis 会话热缓存 | v0.7 | 先把权威存储做对，缓存是后面的优化 |
| 用户画像 / 记忆持久化 | v0.7 | 那是记忆版的内容，本版只搬会话 |
| HTTP 服务 | v0.6 | — |
| 多租户计费账本表 | v0.11 | 本版只把 `tenantId` 字段与索引预留出来 |
| 缓存 token 计价 | v0.7 | — |
| 历史 JSONL 数据迁移工具 | 不做 | `sessions/` 里是测试产物，v0.2 已停止跟踪，无生产数据可迁 |

## 四、验收标准

| # | 判据 | 验证方式 |
|---|---|---|
| D1 | 迁移可重复执行且幂等（跑两次结果一致，不报错） | `tests/store/migrate.test.ts` |
| D2 | 会话事件追加后可完整读回，顺序与写入一致 | `tests/store/session-store.test.ts` |
| D3 | **并发追加 50 条不丢不乱序**（JSONL 方案在此会产生半行） | 同上，`Promise.all` 并发写 |
| D4 | 可按 `userId` / `tenantId` 列出会话，且按时间倒序 | 同上 |
| D5 | 退款 `UNIQUE(order_id)` 真幂等：并发 10 次只建 1 单 | `tests/store/refund-store.test.ts` |
| D6 | `Session` 异步 API 下 `getMessages()` 投影行为与 v0.3 一致 | `tests/session.test.ts` 改写后仍覆盖原有性质 |
| D7 | `AgentLoop` 全部既有行为不变（202 条用例基线） | `npm run verify` |
| D8 | `ContextManager.trimMessages` 已删除且无引用 | `grep -c trimMessages src/` → 0 |
| D9 | 无 `DATABASE_URL` 时零配置可跑（PGlite） | `npm start` 不报连接错误 |
| D10 | 用例数不净减（基线 **202**） | `npm run verify` |

## 五、风险预判

| 风险 | 影响 | 缓解 |
|---|---|---|
| `Session` 同步 → 异步是破坏性变更 | `AgentLoop` 有 6 处调用点、`session.test.ts` 9 条用例、`agent-loop.test.ts` 的断言 | 一次改完全量复跑；`tsconfig.test.json`（v0.3 建的）会静态抓到漏改 |
| PGlite 每个测试新建实例可能很慢 | 测试时长失控 | 先测单实例创建耗时；若慢则每个测试文件共享一个实例、用独立 schema 或 `TRUNCATE` 隔离 |
| PGlite 与真 PG 的行为差异 | 生产炸而测试绿 | PGlite 是真 Postgres（18.3）编译产物，SQL 层一致；仍在 REPORT 里明确「未在真实 PG 上验证过」 |
| 引入 3 个新依赖（pglite / pg / @types/pg） | 依赖面扩大 | `pg` 只在 `PgPoolDatabase` 里 import，不进默认路径；PGlite 是本地默认引擎 |
| 并发测试可能因 PGlite 单连接串行化而「假通过」 | D3 验不出真并发问题 | 断言的是**结果正确性**（不丢、有序），不是并发度；并在 REPORT 注明 PGlite 的连接模型 |
