# v1.2 · 结构化错误、会话并发、追踪与清理（P1 收口）

> 起点 `v1.1`（`e7da7f9`）｜ 还清 [ROADMAP](../../ROADMAP.md) 第七节的 D-4 ~ D-7

---

## 一、迭代目的

v1.1 把「调用方是谁」建进了系统。这一版还的是它当场记下的四笔账 ——
**四条都不是新功能，全是「现在这样会出事，只是还没出」。**

| # | 债 | 现状 | 出事的样子 |
|---|---|---|---|
| D-4 | `AgentLoop` 吞掉模型异常 | 把 `LLM调用失败: xxx` 当**正常回复正文**返回 | CLI 把它当客服的回答打给用户；v1.1 只在 HTTP 层打了补丁 |
| D-5 | 会话并发写入无控制 | 两个请求同时进同一个会话，各自 restore 一份快照再各自追加 | 消息交错，`tool_use` 与 `tool_result` 配对错乱 —— **而 v0.3 的投影逻辑对顺序敏感** |
| D-6 | 幂等记录只增不减 | 有 `expires_at`，但没有任何东西读它 | 表无限增长；`claim` 的主键冲突路径越来越慢 |
| D-7 | 没有分布式追踪 | 只有 `traceId` 透传 + Prometheus 计数 | 拆服务后「这次为什么慢」答不上来 —— 而 v0.15 拆分正是为了上规模 |

### 为什么这四条要一起做

它们看着无关，其实是**同一件事的四个面：一次请求的完整事实**。

```
一次请求出了问题，你需要知道 ——
  它失败了吗？          → D-4（结构化结果，不是一句中文）
  它是不是和别的请求打架了？→ D-5（会话独占）
  它花的时间在哪一段？    → D-7（span）
  这些记录留多久？        → D-6（生命周期）
```

v0.14 建了指标，v1.1 建了身份，这一版建的是**单次请求的可解释性**。

## 二、核心设计

### ⚙️ 设计① `run()` 返回结构化结果，而不是一句话

```ts
export interface TurnResult {
  reply: string;
  outcome: 'ok' | 'blocked' | 'cancelled' | 'error' | 'max_turns';
  error?: { code: TurnErrorCode; message: string; retryable: boolean };
}
```

**关键是 `reply` 与 `outcome` 分开。** 现在的实现把两者揉在一个字符串里，
于是调用方只能靠**字符串匹配**判断成败 —— 而字符串是给人看的，随时会改。

`retryable` 不是装饰：调用方据它决定「换个说法再问一次」还是「转人工」。
把它交给调用方自己猜，等于每个接入方都要重新发明一遍判断逻辑，且各不相同。

**错误正文不再冒充回复**：`outcome !== 'ok'` 时 `reply` 是空串。
「失败时给一句像样的话」听起来贴心，实际是让失败看起来像成功 ——
这个项目从 v0.12 起一直在修的就是这个物种。

### ⚙️ 设计② 会话独占：并发的第二轮直接 409，而不是排队

```
POST /v1/chat  (session S)  ──▶ 拿到 S 的锁 ──▶ 跑完 ──▶ 释放
POST /v1/chat  (session S)  ──▶ 拿不到      ──▶ 409 session_busy
```

**不排队**是刻意的：排队意味着第二个请求要挂着等一次完整的模型调用（秒级），
连接被占住，而调用方并不知道自己在排队。**一个会话就是一段对话，
同一段对话同时说两句话本身就不是合法用法** —— 与其猜他想要什么，不如明确告诉他。

锁带 TTL（缺省 60s），进程崩了不会把会话永久钉死 —— 与 v1.1 幂等占位同一个模式。

### ⚙️ 设计③ 追踪：自己实现 span，不引 OTel SDK

```
span: http.request
  ├─ span: pipeline.beforeTurn      （safety / profile / intent / routing）
  ├─ span: model.chat               ×N 轮
  ├─ span: tool.execute             ×M 个（远程时跨进程）
  └─ span: pipeline.afterTurn
```

不引 `@opentelemetry/*` 的理由和不引 LangChain 一样：
**这个系统里"一次请求由哪些段构成"是核心资产**，它该是可读可测的代码。
OTel SDK 带来的是自动埋点与生态 —— 而我们要埋的点一共就四类，
自动埋点反而会把 `pg`、`fetch` 的噪声也一起收进来。

导出走 **OTLP/HTTP + JSON**（`fetch`，零依赖）。协议是公开的，
真实 collector 照收；同时保留一个内存环形缓冲，让 `/v1/traces/:id` 在
没有 collector 的环境下也能直接看到链路。

跨进程用 **W3C `traceparent`**，不自造头：工具服务日后可能被别的系统调用，
自造格式等于把整条链路锁死在自家生态里。

### ⚙️ 设计④ 清理是后台任务，不是请求路径上的顺手活

「顺便在 claim 时删几条过期的」看着省事，代价是把**不确定的删除耗时**
加到每个请求上，且删除量与流量成正比 —— 流量高峰恰恰是最不该做清理的时候。

独立的 sweeper：固定周期、单次有上限、`unref()` 不阻止进程退出。

## 三、边界

### ✅ 本版做

| # | 事项 |
|---|---|
| 1 | `TurnResult` + `TurnErrorCode`，`AgentEvent.error` 带上 `code` / `retryable` |
| 2 | HTTP 层按 `outcome` 映射状态码（`error`→502、`blocked`→200 带 blocked、`cancelled`→499 语义） |
| 3 | CLI 不再把错误正文当回复打印 |
| 4 | 会话独占锁（DB 级 compare-and-set + TTL），并发第二轮 409 `session_busy` |
| 5 | `Tracer` / `Span` / `SpanExporter`，四类 span 埋点 |
| 6 | OTLP/HTTP JSON 导出器 + 内存环形缓冲 + `GET /v1/traces/:traceId` |
| 7 | W3C `traceparent` 跨进程传播（编排层 ↔ 工具服务） |
| 8 | `IdempotencyStore.purgeExpired` + 后台 sweeper |
| 9 | `/healthz` 暴露 tracing 档位（`otlp` / `memory` / `off`） |

### ❌ 本版不做（以及为什么）

| 事项 | 为什么 |
|---|---|
| 引入 OpenTelemetry SDK | 见设计③。要接生态时，OTLP 协议已经是标准的那一层，换实现不用改埋点 |
| span 采样 | 当前量级下全采样成本可忽略。**没有真实流量数据就定采样率是拍脑袋** |
| 会话锁排队/公平性 | 见设计②。同一会话并发不是合法用法，不该为它做调度 |
| 配额预留-提交（消除超发） | 需要处理预留泄漏，且超发上限有界可算（并发 × 单轮用量）。v1.1 已写明，仍不值得 |
| 模型 provider fallback | 换模型会改变回答风格与工具调用倾向，**静默降级是另一种"看起来在工作"**。要做必须连评测一起做 → v1.3 |
| 跨实例的 `/v1/traces` | 环形缓冲是本实例的。要全局查询就该上真 collector —— OTLP 已经通了 |

## 四、验收判据

### D-4 结构化结果

| # | 判据 |
|---|---|
| P1 | 正常轮次 `outcome === 'ok'`，`reply` 非空 |
| P2 | 模型抛错 → `outcome === 'error'`，`error.code === 'model_error'`，`retryable === true` |
| P3 | 🔴 **失败时 `reply` 是空串**，错误正文不冒充回复 |
| P4 | 中间件拦截 → `outcome === 'blocked'`，`error.retryable === false` |
| P5 | 取消 → `outcome === 'cancelled'`，**不带 error**（取消不是错误，v1.0 已定调） |
| P6 | 达到 maxTurns → `outcome === 'max_turns'` |
| P7 | `error` 事件带 `code` 与 `retryable` |
| P8 | `/v1/chat/sync` 模型失败 → 502 `upstream_error`（v1.1 行为不变） |
| P9 | 🔴 CLI 不把错误正文当回复打印 |

### D-5 会话并发

| # | 判据 |
|---|---|
| P10 | 🔴 同一会话两个请求并发 → 一个 200、一个 409 `session_busy` |
| P11 | 🔴 409 的那个**一次模型调用都不发生**，也不写任何 entry |
| P12 | 第一个结束后，第二个重发能正常拿到锁 |
| P13 | 不同会话并发互不影响 |
| P14 | 锁过期后可被抢占（进程崩溃不把会话永久钉死） |
| P15 | 🔴 请求异常结束时锁被释放（不是等 TTL） |

### D-7 追踪

| # | 判据 |
|---|---|
| P16 | 一次对话产出 http/model/tool 三类 span，同一个 `traceId` |
| P17 | 🔴 span 有正确的父子关系（tool span 的 parent 是 http span） |
| P18 | span 记录耗时且 `end > start` |
| P19 | 失败的 span 标 `status: 'error'` 并带错误信息 |
| P20 | 🔴 `traceparent` 跨进程传播：工具服务里的 span 与编排层同 traceId |
| P21 | OTLP 导出器产出**合规的 OTLP/HTTP JSON 结构**（resourceSpans → scopeSpans → spans） |
| P22 | 🔴 导出失败不影响请求（追踪是观测，不是依赖） |
| P23 | `GET /v1/traces/:traceId` 返回本实例的 span 列表，越权按租户 404 |
| P24 | 环形缓冲有上限，不会无限增长 |

### D-6 清理

| # | 判据 |
|---|---|
| P25 | `purgeExpired` 只删过期记录，未过期的一条不动 |
| P26 | 🔴 已完成但未过期的记录**不能被删**（它们是要被重放的资产） |
| P27 | 单次删除有上限（不会一次锁住整张表） |
| P28 | sweeper 定时触发，且 `unref()` 不阻止进程退出 |

### 回归

| # | 判据 |
|---|---|
| P29 | 用例不净减（基线 **738**） |
| P30 | `npm run verify` exit 0 |
| P31 | `npm run eval` 三维门通过 |
| P32 | 拆分形态行为不变 |

## 五、偏离 SPEC 的处理

沿用 ROADMAP 第五节：**偏离先回来改 SPEC（标注「中途追加 · 原因」），再动手。**
