# v1.2 迭代报告 · 结构化错误、会话并发、追踪与清理

> 起点 `e7da7f9`（v1.1）｜ 用例 **738 → 795**（+57）｜ `npm run verify` exit 0
> **D-4 ~ D-7 全部还清。**

---

## 一、交付了什么

| # | 事项 | 落点 |
|---|---|---|
| 1 | `TurnResult`：`reply` 与 `outcome` 分离，错误带 `code` / `retryable` | [types.ts](../../../src/core/types.ts) · [agent-loop.ts](../../../src/core/agent-loop.ts) |
| 2 | HTTP / SSE / CLI 按 outcome 分支 | [app.ts](../../../src/server/app.ts) · [sse.ts](../../../src/server/sse.ts) · [index.ts](../../../src/index.ts) |
| 3 | 会话独占锁（compare-and-set + TTL），并发第二轮 409 | [pg-session-store.ts](../../../src/store/pg-session-store.ts) |
| 4 | `Tracer` / `Span` / OTLP-HTTP / 内存环形缓冲 | [tracing.ts](../../../src/observability/tracing.ts) |
| 5 | 四类 span 埋点 + W3C `traceparent` 跨进程传播 | loop / app / tool-service / remote-gateway |
| 6 | `GET /v1/traces/:traceId` | [app.ts](../../../src/server/app.ts) |
| 7 | `purgeExpired` + 后台 sweeper | [sweeper.ts](../../../src/server/sweeper.ts) |

## 二、核心设计的实际结果

### ⚙️ 设计① `reply` 与 `outcome` 分离

```diff
- return errorMsg;                  // 「LLM调用失败: xxx」被当成回复正文
+ return {
+   reply: '',                      // 失败不该看起来像成功
+   outcome: 'error',
+   error: { code: 'model_error', message: errorMsg, retryable: true },
+ };
```

**`reply` 置空是这一条的核心。** 「失败时给一句像样的话」听起来贴心，
实际是让失败伪装成回答 —— 这个项目从 v0.12「谎称已处理」起一直在修的就是这个物种。

`retryable` 不是装饰：调用方据它决定「换个说法再问一次」还是「转人工」。
交给每个接入方自己猜，等于每家发明一套不同的判断逻辑，且各不相同。

**只有 `error` 走 5xx。** `blocked`（安全/配额拦截）与 `max_turns` 是**业务上成立的结果** ——
它们发生在一次正常的交互里，用 5xx 表达会让监控上的错误率变成噪声（v1.0 定的调）。
它们靠响应体里的 `outcome` 与调用方沟通。

断电验证：把 `reply` 改回错误正文，2 条转红。

### ⚙️ 设计② 会话独占：并发第二轮 409，不排队

先说清这个 bug 的形状，因为它容易被想成"覆盖写"：

```
会话是**追加式**的 —— 并发不会覆盖数据。
它造成的是：两个请求各自 restore 一份快照、各自往同一条会话追加，
消息顺序交错，`tool_use` 与产生它的 `tool_result` 被别的消息隔开。
而 v0.3 的投影逻辑对顺序敏感 —— **下一轮 restore 出来的历史直接是坏的**。
```

所以它不是"两个人同时说话谁赢"的问题，是**会话历史被悄悄写坏**的问题，
而且要等到下一轮才发作。

```sql
UPDATE sessions SET turn_locked_until = $3
 WHERE id = $1 AND (turn_locked_until IS NULL OR turn_locked_until < $2)
 RETURNING id
```

compare-and-set 而不是「先查再写」：后者在并发下两个请求会同时查到「没锁」、
同时认为自己拿到了 —— 而这把锁存在的全部意义就是应付并发。

**不排队**是刻意的（见 SPEC 设计②）。锁带 TTL，进程崩了不会把会话永久钉死；
但正常路径一定在 `finally` 里释放 —— **靠 TTL 兜底意味着一次异常会让这条会话罚站一分钟**。

断电验证：拿不到锁也放行，4 条转红。

### ⚙️ 设计③ 追踪：自己实现 span，但用标准协议导出

不引 `@opentelemetry/*` 的理由和不引 LangChain 一样：
「一次请求由哪些段构成」是核心资产，该是可读可测的代码。要埋的点一共四类，
自动埋点反而会把 `pg`、`fetch` 的噪声一起收进来。

**但导出协议用标准 OTLP/HTTP JSON** —— 协议是公开的，真实 collector 照收。
自造协议才是把自己锁死在自家生态里。同理跨进程用 W3C `traceparent`：

```
http.chat.sync
  ├─ model.chat        ×N 轮
  └─ tool.execute      ← 编排层这一侧
       └─ tool.service.execute   ← 工具服务那一侧（同 traceId，父子正确）
```

最后那一层嵌套是 v0.15 拆分之后一直缺的东西：**「网络往返」与「工具真正跑了多久」
必须能分开看** —— 混在一起时，慢的到底是网络还是工具是猜不出来的。

链路号顺带从 `tr_<base36>` 换成 W3C 规格的 32 位十六进制。好认输给了可互操作。

断电验证：不传 traceparent，跨进程那条转红。

### ⚙️ 设计④ 清理是后台任务

「顺便在 claim 时删几条过期的」看着省事，代价是把不确定的删除耗时加到每个请求上，
且删除量与流量成正比 —— **流量高峰恰恰是最不该做清理的时候**。

单次删除有上限：一次 `DELETE` 扫全表会长时间持锁，而这张表同时是幂等占位的热点表。

判据只看 `expires_at`，**不看 status**：已完成的记录同样要在 TTL 之后消失，
而"未过期的已完成记录"是要被重放的资产 —— 由 `expires_at` 天然保护，不需要第二个条件。

## 三、做的过程中挖出来的一个洞

### 🔴 `/v1/traces/:id` 的归属判定，第一版是错的

第一版按「逐个 span 过滤 tenant 属性」判归属：

```ts
// 错的
const own = spans.filter(
  (s) => !s.attributes.tenant || canAccessTenant(principal, String(s.attributes.tenant))
);
```

`model.chat` 和 `tool.execute` 上**根本没有 tenant 属性** —— `!s.attributes.tenant`
对它们恒真，于是它们直接漏给任何人。而工具 span 的属性里带着工具名。

写用例时当场被抓住（P23 期望 404，实际 200）。改成**归属由 http span 决定**：
一条链路属于发起它的那个请求，这是唯一说得通的归属定义。

值得记一笔的是失败模式：**「默认放行 + 逐项排除」在数据缺失时会静默放行**，
而「先找到权威来源，找不到就拒绝」不会。v1.1 那条「安全规则只能加严不能放宽」
是同一个道理的另一面。

## 四、验收

| # | 判据 | 结果 |
|---|---|---|
| P1–P7 | `TurnResult` 五种 outcome + 事件带 code/retryable | ✅ 断电验证过 |
| P8 | 模型失败 → 502 upstream_error | ✅ |
| P9 | CLI 不把错误正文当回复 | ✅ 且提示 retryable |
| P10–P15 | 会话独占六条 | ✅ 用可控闸门，非 sleep |
| P16–P20 | span 树 / 耗时 / 错误 / 跨进程 | ✅ 断电验证过 |
| P21 | OTLP 结构合规（纳秒字符串、属性类型映射） | ✅ 逐字段断言 |
| P22 | 导出失败不影响请求 | ✅ |
| P23–P24 | `/v1/traces` 越权 404 · 环形缓冲有上限 | ✅ 修过一次归属判定 |
| P25–P28 | 清理四条 | ✅ 断电验证过 |
| P29 | 用例不净减（基线 738） | ✅ **795** |
| P30 | `npm run verify` exit 0 | ✅ |
| P31 | `npm run eval` 三维门 | ✅ 质量 100% · 成本 736 · p95 41ms |
| P32 | 拆分形态行为不变 | ✅ |

### 断电验证记录

| 断掉什么 | 转红 |
|---|---|
| 失败时把错误正文当回复返回 | 2 条 |
| 拿不到锁也照常放行 | **4 条** |
| 不传 traceparent 给工具服务 | 1 条 |
| `purgeExpired` 不看过期时间 | **6 条** |
| 链路归属改回逐 span 过滤 | 1 条 |

## 五、偏离 SPEC 的记录

无。三处实现细节在 SPEC 范围内自行决定（span 名称、`/v1/traces` 的响应字段、
sweeper 的默认周期），都不改变交付面。

## 六、坦白留在原地的东西

| 事项 | 为什么不做 | 归属 |
|---|---|---|
| span 采样 | 当前量级下全采样成本可忽略。**没有真实流量数据就定采样率是拍脑袋** | 有量之后 |
| 跨实例的 `/v1/traces` | 环形缓冲是本实例的。要全局查询就该上真 collector —— OTLP 已经通了 | 不做 |
| 配额预留-提交 | 超发上限有界可算（并发 × 单轮用量）。代价是处理预留泄漏 | 不做 |
| 模型 provider fallback | 换模型会改变回答风格与工具调用倾向，**静默降级是另一种"看起来在工作"**。要做必须连答案质量评测一起做 | v1.3 |
| Prompt 版本管理与灰度 | 改 prompt 是最频繁的变更，却是唯一要发版的变更。但它需要评测集先能判好坏 | v1.3 |
| 答案质量评测 | 需要真实 API + 人工标注集。假装脚本化评测能覆盖它就是制造虚假安全感 | v1.3 |
