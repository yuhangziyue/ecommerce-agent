# v1.2 实施计划

> 对应 [SPEC.md](SPEC.md)。**先红后绿，每步跑命令验证。**

---

## 一、文件清单

### 新建

| 文件 | 内容 |
|---|---|
| `src/observability/tracing.ts` | `Tracer` / `Span` / `SpanExporter` / `MemorySpanExporter` / `OtlpHttpExporter` / W3C `traceparent` 解析与生成 |
| `src/server/sweeper.ts` | 过期幂等记录的后台清理 |
| `tests/observability/tracing.test.ts` | span 树、traceparent、OTLP 结构、导出失败降级 |
| `tests/server/concurrency.test.ts` | 会话独占（P10–P15） |
| `tests/core/turn-result.test.ts` | 结构化结果（P1–P7） |
| `tests/server/sweeper.test.ts` | 清理（P25–P28） |

### 修改

| 文件 | 改什么 |
|---|---|
| `src/core/types.ts` | `TurnResult` / `TurnErrorCode`；`AgentEvent.error` 加 `code` / `retryable` |
| `src/core/agent-loop.ts` | `run()` 返回 `TurnResult`；四类退出路径各自给 outcome；埋 model span |
| `src/store/migrations.ts` | `011_session_turn_lock` |
| `src/store/types.ts` · `pg-session-store.ts` | `acquireTurnLock` / `releaseTurnLock` |
| `src/auth/types.ts` · `pg-idempotency-store.ts` | `purgeExpired` |
| `src/server/app.ts` | 会话锁、按 outcome 映射状态码、http/tool span、`/v1/traces/:id`、sweeper 装配 |
| `src/tool-service/app.ts` | 接 `traceparent`，产出 tool span |
| `src/tools/remote-gateway.ts` | 发 `traceparent` |
| `src/index.ts`（CLI） | 按 `outcome` 分支，错误不当回复打印 |
| `src/server.ts` | tracing / sweeper 的环境变量装配 |
| `tests/agent-loop.test.ts` 等 | `run()` 返回值解构 |

## 二、关键接口

```ts
// src/core/types.ts
export type TurnErrorCode =
  | 'model_error'      // 模型调用失败 —— 可重试
  | 'blocked'          // 中间件拦截（安全/配额）—— 重试没用
  | 'max_turns'        // 工具循环没收敛
  | 'internal_error';

export interface TurnResult {
  reply: string;
  outcome: 'ok' | 'blocked' | 'cancelled' | 'error' | 'max_turns';
  error?: { code: TurnErrorCode; message: string; retryable: boolean };
}
```

```ts
// src/observability/tracing.ts
export interface SpanData {
  traceId: string; spanId: string; parentSpanId?: string;
  name: string; startTime: number; endTime: number;
  status: 'ok' | 'error'; attributes: Record<string, string | number | boolean>;
  error?: string;
}
export interface SpanExporter { export(spans: SpanData[]): Promise<void>; }

export class Tracer {
  startSpan(name: string, opts?: { parent?: Span; attributes?: ... }): Span;
  // 注入时钟（沿用 v1.0 熔断器 / v1.1 限流的做法）
}
```

```ts
// SessionStore（v1.2）
acquireTurnLock(sessionId: string, ttlMs: number, now: number): Promise<boolean>;
releaseTurnLock(sessionId: string): Promise<void>;
```

## 三、TDD 步骤

| # | 步骤 | 验证 |
|---|---|---|
| 1 | 🔌 `TurnResult`：先改用例断言 `outcome`（必须红）→ 改 loop | `vitest run tests/core tests/agent-loop.test.ts` |
| 2 | HTTP / CLI 按 outcome 分支 | `vitest run tests/server` |
| 3 | 🔌 会话锁：先写「并发第二个必须 409」用例（必须红）→ 迁移 + store + app | `vitest run tests/server/concurrency.test.ts` |
| 4 | Tracer 纯逻辑（span 树 / traceparent / OTLP 结构 / 导出失败降级） | `vitest run tests/observability` |
| 5 | 🔌 埋点 + 跨进程传播 | `vitest run tests/observability tests/split` |
| 6 | 🔌 `purgeExpired` + sweeper | `vitest run tests/server/sweeper.test.ts` |
| 7 | 全量 + 评测门 + 断电验证 | `npm run verify && npm run eval` |

### 第 3 步的写法（关键）

并发用例**不能靠 sleep 碰运气**。用一个能被测试卡住的 provider：

```ts
// provider 在第一次调用时挂起，直到测试放行 —— 这样"并发"是确定性的
const gate = new Deferred();
provider.onChat = () => gate.promise;

const first = client.inject({ ... });      // 不 await，占住锁
await provider.entered;                     // 确认它真的进去了
const second = await client.inject({ ... }); // 这一个必须 409
gate.resolve();
await first;
```

## 四、风险预判

| 风险 | 处置 |
|---|---|
| `run()` 改返回类型波及 ~20 处用例 | 机械解构 `const { reply } = await ...`。**不做兼容包装** —— 那会留下两个真相 |
| 会话锁让既有用例串行失败 | 锁在轮次结束即释放；既有用例本来就是顺序发的 |
| 追踪埋点拖慢请求 | span 只是内存对象；导出异步且失败降级。三维门的 latency 上限（63ms）会兜住 |
| sweeper 在测试里泄漏定时器 | `unref()` + `app.onClose` 停掉；用例注入手动触发的 tick |
| OTLP 结构写错但没人发现 | 用例直接断言 JSON 形状（resourceSpans/scopeSpans/spans + 纳秒时间戳字符串） |

## 五、不改的东西

- 配额、安全、路由、工具层一行不改。
- 错误体形状 `{error:{code,message}}` 沿用。
