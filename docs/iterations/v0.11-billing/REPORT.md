# v0.11 迭代报告 · 计费与配额

> 起点 `a6ebc43`（v0.10）｜ 用例 **390 → 433**（+43）｜ `npm run verify` exit 0
> **本版还清了 v0.2 欠的账：`maxTokensPerSession` 这个名字一直是假的。**

---

## 一、先看修之前有多糟

动手前先写探针，让 bug 自己现形：

```
第0轮: blocked=undefined     第3轮: blocked=undefined
第1轮: blocked=undefined     第4轮: blocked=undefined
第2轮: blocked=undefined     模型总共被调用 5 次
```

**同一个会话烧掉 300,500 tokens，上限写着 100,000，一次都没拦。**

罪魁是 `prepareTurn` 里的一行：

```ts
const tracker = new TokenTracker();   // ← 每个 HTTP 请求新建
```

`BudgetGuard` 读的就是这个实例。于是 `maxTokensPerSession` 实际限制的是
「**单个 HTTP 请求内、多轮工具调用之间**」的用量。纯文本回复场景下一个请求
只调一次模型 —— 计数器从 0 开始、加一次、随请求销毁，**熔断永远不可能触发**。

这个 bug 有三层伪装，每一层都让它更难被发现：
1. `BudgetGuard` 自己的单元测试是对的（给它一个装满的 tracker，它确实会拦）
2. 中间件确实接进了管道（v0.2 专门验证过「运行时可达」）
3. 名字叫 `maxTokensPerSession`，读代码的人不会怀疑它限的不是 session

> 这是同一个病的第三次发作：
> - **v0.2**：能力写好了但没接进管道 → 接线
> - **v0.10**：脱敏接了，但保护的是返回值而非用户看的流 → 双出口只测一条
> - **v0.11**：接了、通了、口径也对，但**状态活不过一个请求**
>
> 三次的共同点：**单元测试全绿，端到端行为是错的。**
> 能抓住它们的只有一件事 —— 沿着用户真实走的那条路，从头到尾跑一遍。

## 二、交付了什么

| # | 事项 | 落点 |
|---|---|---|
| 1 | `004_usage_records` 计费账本表 | [migrations.ts](../../../src/store/migrations.ts) |
| 2 | `PgUsageStore`：追加 + 多维聚合 | [pg-usage-store.ts](../../../src/store/pg-usage-store.ts) |
| 3 | `QuotaService` 两级配额 + 两种计数器 | [quota.ts](../../../src/billing/quota.ts) |
| 4 | `quota` 中间件（取代 `budget-guard`） | [quota.mw.ts](../../../src/middleware/quota.mw.ts) |
| 5 | `AgentLoop.onUsage` 钩子 | [agent-loop.ts](../../../src/core/agent-loop.ts) |
| 6 | 服务端落账 + 429 预检 + `quota` SSE 事件 | [app.ts](../../../src/server/app.ts) |
| 7 | `GET /v1/tenants/:id/usage` | 同上 |
| 8 | 延迟与超发基准 | [bench-quota.ts](../../../scripts/bench-quota.ts) |

## 三、核心设计的实际结果

### ⚙️ 设计① 真相在库里

修完之后，同样的探针：

```ts
expect(outcomes).toEqual([true, true, true, true, false]);
expect(provider.calls).toBe(4);   // 不再是无限次
```

`onUsage` 钩子挂在 **Loop 而不是中间件**上，因为一轮里可能调多次模型（工具循环），
中间件只看得到轮边界 —— 按轮记账会漏掉除最后一次外的全部用量。

成本**在写入时定格**：`NUMERIC(20,10)` 存，不用浮点，也不在查询时按当前价重算。
价格会变（v0.3 的 `PriceWindow` 就是为此存在），历史账单不该跟着变。

```ts
it('🔴 累计 200 条小额记录不产生浮点漂移', async () => {
  for (let i = 0; i < 200; i++) await store.append(record({ costUsd: 0.0001 }));
  expect((await store.sumByTenant('t_acme')).costUsd).toBe(0.02); // 严格相等
});
```

### ⚙️ 设计② 两级配额：区别在「能不能自救」

| 级别 | HTTP | 语义 |
|---|---|---|
| 会话 | **200** + `blocked` | 对话长度管理 —— 换个会话就能继续 |
| 租户 | **429** `quota_exceeded` | 商业事件 —— 换会话没用，要提额 |

用状态码区分这两件事，调用方才能写出正确的重试逻辑。
两级同时越限时**优先报租户** —— 先告诉用户那个换会话也解决不了的。

```ts
it('🔴 换会话能绕过会话配额，但绕不过租户配额（配额分级的意义）', ...)
```

越限级别通过 `onExceeded` 回调传给 HTTP 层，**不靠解析 reason 文案**：
文案改一个字就会悄悄退化成 200，而这类退化没有任何报错。

### ⚙️ 设计③ 计数器是账本的缓存，不是账本

`INCRBY` 天然原子且返回新值，不需要 Lua。实测 50 并发累加：

```
expect(await counter.get('session', 'sesn_atomic')).toBe(50 * 100);  // 5000，一次不漏
```

关键细节是**回库重建后再累加**，而不是从 0 起算 —— 否则 Redis 键一过期就等于免单：

```ts
it('🔴 回库重建后继续累加，不从 0 起算（否则重启即免单）', ...)
```

## 四、实测数字

### 配额检查的代价

```
计数器              中位延迟      p95
DB 直读                0.432ms     0.656ms
Redis 计数器           0.222ms     0.324ms
```

进程内 PGlite 下 Redis 只快 1.9×，但**生产里 DB 是跨网络的，差距会大得多**。
这正是计数器存在的理由：配额检查在每个请求的关键路径上，账本聚合不该出现在那里。

### 并发超发上限（SPEC 承诺要给的数字）

```
  并发  1：1 个请求同时通过检查 → 最大超发   6,000 tokens
  并发  2：2 个请求同时通过检查 → 最大超发  12,000 tokens
  并发  4：4 个请求同时通过检查 → 最大超发  24,000 tokens
  并发  8：8 个请求同时通过检查 → 最大超发  48,000 tokens
  并发 16：16 个请求同时通过检查 → 最大超发  96,000 tokens
```

**超发上限 = 并发数 × 单轮最大用量，严格线性，有界且可预测。**

不假装它是精确的。要精确需要预留-提交（reserve-then-commit），代价是处理
预留泄漏（请求崩溃后额度悬空需要超时回收）—— 那个复杂度换这点精度不值：
租户配额通常以百万计，16 并发的极端情况多送十万级，且**下一个请求必然被拦**。

## 五、过程中发现的问题

### 🟡 `truncateAll` 的硬编码表名列表咬了一口

新加 `usage_records` 后忘了加进 `truncateAll` 的表名列表，结果**数据在用例之间串**，
8 个用例莫名转红，而报错信息（「期望 500 得到 3500」）完全指向错误的方向——
看起来像聚合 SQL 写错了。

改成从 `pg_tables` 查：

```sql
SELECT tablename FROM pg_tables
 WHERE schemaname = 'public' AND tablename <> 'schema_migrations'
```

> 这类「每次加东西都要记得同步」的清单，只要靠人记就一定会漏。
> 能从系统里查出来的，就不要写死。

### 🟢 `tsconfig.test.json` 这次救了场

`Stores` 加了 `usage` 字段后，测试 helper 没跟上。`npx tsc --noEmit`（只查 src）
一声不响，但 `npm run typecheck` 精确点出 6 个调用点：

```
tests/server/chat.test.ts(90,5): error TS2741: Property 'usage' is missing ...
tests/server/sessions.test.ts(37,7): error TS2741: ...
```

不修的话表现是**每个用 buildApp 的用例炸成 500**，而 500 离真正原因十万八千里。
v0.3 补的这份配置、v0.10 又把 `scripts/` 纳进来，这一版兑现了收益。

顺手给 helper 加了显式返回类型 `Promise<Stores>` —— 靠推断的话，
漏字段时错误会出现在**每一个调用点**而不是定义处。

## 六、验收

| # | 判据 | 结果 |
|---|---|---|
| B1 | 同会话跨请求累计超限被拦 | ✅ `[true,true,true,true,false]`，模型调用 5→4 次 |
| B2 | 重启后用量仍在 | ✅ 全新 app 实例仍被拦 |
| B3 | 每次调用落账，成本按当时价 | ✅ `pricing_resolved = 'exact'` |
| B4 | 租户越限 → 429 | ✅ SSE 路由也在写头之前返回 |
| B5 | 会话越限 → 200 + blocked | ✅ |
| B6 | Redis 不可用回库，行为不变 | ✅ 连不上时降级不抛错 |
| B7 | 并发扣减不丢更新 | ✅ 50 并发 = 5000，真 Redis 实测 |
| B8 | 超发上限有实测数字 | ✅ 见上，1/2/4/8/16 并发 |
| B9 | `GET /v1/tenants/:id/usage` | ✅ 含未知租户返回全零 |
| B10 | 用例不净减（基线 390） | ✅ **433** |
| B11 | `npm run verify` exit 0 | ✅ 连跑 3 次稳定 |

### 红绿验证记录

| 断掉什么 | 转红的用例 |
|---|---|
| 配额退回进程内 `budget-guard` | 跨请求累计 / 越限 200+blocked / 重启不清零（3 条） |
| 把 Redis 并发断言改成必然失败的值 | 确认那组用例**真的连上了 6380 而不是静默跳过** |

> 第二条是刻意做的：`if (!available) return` 这种跳过写法本身就是
> 「测试全绿 ≠ 能力生效」的温床 —— 得验证它确实跑了。

## 七、留给后面的

| 事项 | 去向 |
|---|---|
| 按租户配不同规则集（v0.10 承诺） | v0.13 |
| 按租户配不同价格 / 出账单 | 不做（需要合同模型，超出 agent 范畴） |
| 预留-提交式精确扣减 | 不做（见设计③，复杂度不抵收益） |
| 配额用量进可观测指标 | v0.14 |
