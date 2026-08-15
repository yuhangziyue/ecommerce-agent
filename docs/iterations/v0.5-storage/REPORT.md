# v0.5 存储层 · 实测报告

> 完工 2026-08-15 ｜ Tag `v0.5` ｜ 起点 `a244c0c`(v0.4)
> **v0.6 服务化的硬前置已就位**：会话不再绑定进程与本地文件。

---

## 一、验收判据逐条（D1–D10）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| D1 | 迁移幂等 | ✅ | 首次返回 `['001_init']`，第二次返回 `[]`，不报错 |
| D2 | 事件追加后按序读回 | ✅ | `按写入顺序读回`：`['a','b','c','d']` |
| D3 | **并发追加 50 条不丢不乱序** | ✅ | `Promise.all` 50 次并发，条数 50、内容全在、seq 严格递增 |
| D4 | 按 userId / tenantId 倒序列出 | ✅ | `listByUser` 最新在前；`listByTenant` 只返回该租户 |
| D5 | **并发 10 次退款只建 1 单** | ✅ | `ids.size === 1`，`created===true` 只有 1 个，库内 `count(*)===1` |
| D6 | 异步化后投影行为与 v0.3 一致 | ✅ | 投影 5 条 + restore 合法性 5 条全部保留并通过 |
| D7 | AgentLoop 既有行为不变 | ✅ | `agent-loop.test.ts` **32 条全绿**，一条未改断言 |
| D8 | `trimMessages` 已删且无引用 | ✅ | 实现已删；唯一残留是一处**过期注释**，已顺手修正 |
| D9 | 无 `DATABASE_URL` 零配置可跑 | ✅ | `openStores(undefined)` → PGlite，启动横幅打印引擎名 |
| D10 | 用例数不净减（基线 202） | ✅ | **223 passed / 22 files** |

```
$ npm run verify
> tsc --noEmit && tsc -p tsconfig.test.json && vitest run
 Test Files  22 passed (22)
      Tests  223 passed (223)
```

| | v0.4 | v0.5 | 变化 |
|---|---|---|---|
| 用例数 | 202 | **223** | +21 |
| 测试文件 | 19 | 22 | +3 |
| src 文件 / 行 | 29 / 2344 | 36 / 3002 | +7 / +658 |

---

## 二、红-绿验证：一次失败的尝试，和它教给我的事

本版最关键的设计是 **`session_entries` 按 `seq`（`BIGSERIAL`）排序而不是按 `created_at`**。
我试了三次才做出一条**能证伪**的测试，这个过程值得记下来。

### 第一次尝试：直接改排序键 → 没变红

```bash
$ perl -0pi -e "s/ORDER BY seq ASC/ORDER BY created_at ASC/" src/store/pg-session-store.ts
$ npx vitest run tests/store/session-store.test.ts -t '并发'
 ✓ 1 passed
```

**并发那条用例照样通过。** 说明它根本没有在守「排序依据是 seq」这件事 ——
PGlite 把写入串行化到单连接，`created_at` 与 `seq` 的顺序恰好一致。

### 第二次尝试：强制 `created_at` 全部相同 → 仍然没变红

写死三行相同的时间戳插入，期望「排序键相等时顺序不确定」。结果仍然通过 ——
PostgreSQL 在排序键相等时的返回顺序恰好等于堆内顺序（小表、刚插入）。
**「未定义行为恰好符合预期」是无法用这种方式证伪的。**

### 第三次：让 `created_at` 与写入顺序**相反** → 真红了

```
× 排序只依赖写入序，与 created_at 无关（seq 作为排序依据的契约）
  → expected [ 'third', 'second', 'first' ] to deeply equal [ 'first', 'second', 'third' ]
```

恢复后 14/14 通过。

### 教训

**红-绿验证的价值不在「跑一遍流程」，而在它会告诉你测试是不是假的。**
如果我只做第一次尝试就宣布「验证通过」，会得到一条看起来在守关键不变量、
实际什么都没守的测试 —— 而且这条测试会一直绿下去，直到某天真 PG 上出问题。

第二次的失败还纠正了我一个认知错误：我以为「制造出触发条件」就够了，
但**未定义行为不等于会出错**。要证伪，必须构造出「正确实现与错误实现结果必然不同」的输入，
而不是「错误实现可能出错」的输入。

---

## 三、核心设计

### ⚙️ 设计① Store 接口族 + 单一 PG 实现，引擎可换

```
   SessionStore / RefundStore   ← 业务代码只认接口
            │
      PgSessionStore            ← 唯一实现，写标准 SQL
            │
         Database               ← 引擎抽象
        ╱        ╲
 PGliteDatabase   PgPoolDatabase
 （本地/测试）      （生产）
```

**刻意不写内存 Mock 实现。** 常见做法是给测试写内存版，但那会产生 mock 漂移 ——
内存实现在唯一约束、事务、NULL 语义上与真 SQL 不同，测试全绿而生产炸。

PGlite 是**真 PostgreSQL 编译成 WASM**（实测 `PostgreSQL 18.3 (PGlite 0.5.5)`），
所以测试直接打真 SQL：`UNIQUE` 约束、`ON CONFLICT`、`JSONB`、级联删除的行为与生产一致。

> **本机为什么不用 Docker**：实测无 `docker`、无 `psql`（`brew` 可用但不必装）。
> PGlite 让整套存储层**零基础设施**就能开发与测试，而生产只改 `DATABASE_URL`。

### ⚙️ 设计② Session 从同步文件追加改为异步事件表

写入 API 全部改异步。**这是必要的破坏性变更** —— 数据库写不可能同步，
而假装同步（写后台队列）会丢掉「写成功才返回」的持久性保证，
恰恰是 v0.6 服务化最需要的。

读取仍同步（`getEntries` / `getMessages` 走内存缓存）：AgentLoop 每轮高频读历史，
每次打库不现实。缓存在 create/restore 时装载，之后每次写入同步追加，与库保持一致。

`AgentLoop` 有 8 处写入点改为 `await`，其中阶段 4 的结果回喂从 `forEach` 改为
`for...of` 串行 await —— **落库顺序必须与 `tool_use` 顺序一致**，
`forEach` + async 不保证这一点。

---

## 四、修掉的缺陷

| 缺陷 | v0.5 之前 | 现在 |
|---|---|---|
| **无并发保护** | `appendFileSync` 交错写入产生半行，`loadFromFile` 跳过损坏行 = **静默丢消息** | 单条 `INSERT` 原子；并发 50 条不丢不乱序 |
| **无法按用户/租户查询** | 文件名只有 sessionId，只能遍历全部文件解析 | `idx_sessions_user` / `idx_sessions_tenant` 索引 + `listByUser` / `listByTenant` |
| **单机绑定** | 文件在本地磁盘，服务无法水平扩容 | 会话在库里，跨实例可读（用例 `跨实例恢复` 验证） |
| **退款幂等只在进程内**（v0.3 明确写了「不宣称生产级」） | 进程内 Map，重启即失效、多实例无效 | `UNIQUE(order_id)` + `ON CONFLICT DO NOTHING` + 回查；并发 10 次只建 1 单 |
| `trimMessages` 旧盲切版残留 | 生产不用但仍是公开 API | 已删除；过期注释一并修正 |

**退款幂等特别说明**：用的是 `ON CONFLICT DO NOTHING` **加回查**，
不是「先查再插」—— 后者是 TOCTOU 竞态，并发下两个请求都会查到空然后各自插入。
幂等的真实执行者是数据库约束，不是应用层检查。

---

## 五、偏离计划之处

### 1. Task 顺序调整（Task 4 提前到 Task 3 之前）

`PLAN.md` 排的是 Task 3（Session 改异步）→ Task 4（退款 + 删 trimMessages）。
实际先做了退款 store（独立、小、可单独验证），再做 Session 异步化（大、牵连面广）。
**理由**：先把独立的做完，让大重构开始时手上没有别的未完成项。

### 2. `RefundStore` 接口从 `src/tools/` 移到 `src/store/`

原计划是「保留 `src/tools/refund-store.ts` 的接口」。实际把接口定义移到了
`src/store/types.ts`，`src/tools/refund-store.ts` 只保留进程内实现 + 注入入口
（`setRefundStore`）并重导出类型。

**理由**：接口和它的 PG 实现应该在同一层。留在 `tools/` 会造成
「工具层定义存储接口、存储层实现它」的倒挂依赖。

### 3. 新增 `Session.restore` 返回 `null` 的语义

原实现里 `restore` 总是返回 Session（文件不存在就是空会话）。改为**返回 `null`**。
**理由**：v0.6 服务化后，客户端传来过期或伪造的 `sessionId` 是常见路径，
静默返回空会话会让「会话丢失」表现为「模型突然失忆」，而不是一个明确的 404。

---

## 六、遗留问题

| 问题 | 归属 |
|---|---|
| **PGlite 与真实 PG 未做对照验证** —— 本机无法起真 PG，所有 SQL 只在 PGlite 上跑过 | 待环境具备（`brew install postgresql@17` 后跑同一套测试指向真 PG） |
| Redis 会话热缓存 | v0.7 |
| 用户画像 / 记忆持久化 | v0.7 |
| 缓存 token 计价、`getTotalTokens` 漏算缓存、摘 `as any` | v0.7 |
| 流式感知的安全管道 | v0.10 |
| 多租户计费账本表（本版只预留了 `tenant_id` 字段与索引） | v0.11 |
| `sessions/*.events.jsonl`（轨迹日志）仍写本地文件 | v0.14 可观测性版一并处理 |

---

## 七、提交清单

```
60b8bd4 feat(v0.5): Database 引擎抽象与迁移机制 + v0.5 规格计划
<本次>  feat(v0.5): PgSessionStore / PgRefundStore + Session 改异步 + 删除旧盲切裁剪
```

Tag：`v0.5`
