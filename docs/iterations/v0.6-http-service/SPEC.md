# v0.6 · 服务化（HTTP + SSE）

> 起点 `8be0de3`（v0.5）｜ 后继 v0.7 多轮记忆
> **这一版之后，项目不再依赖终端输入 —— 外部系统可以接入了。**

---

## 一、迭代目的

这是整个路线图的**主线目标**：把 Agent 从「终端里跑的程序」变成「能对外提供的服务」。

前五版都是为它铺路，现在前置条件齐了：
- v0.2 中间件管道 —— 鉴权、限流可以作为中间件挂上去而不改 Loop
- v0.3 `Session.restore` 修好 —— 每个 HTTP 请求靠 sessionId 恢复上下文，这条路必须是通的
- v0.4 EventBus + delta 事件 —— SSE 写出器只是**又一个订阅者**
- v0.5 会话落库 —— 服务化后会话不能再存进程内存与本地文件

这一版**不新增任何 Agent 能力**，只做「把已有能力通过标准协议暴露出去」。

## 二、核心设计

### ⚙️ 设计① AgentEvent → SSE 事件，1:1 直通

v0.4 把事件分发收敛到 `EventBus` 的回报在这里兑现：SSE 写出器是**又一个订阅者**，
不需要改 `AgentLoop` 一行。

```
POST /v1/chat  (Accept: text/event-stream)
   │
   ├─ 开库 → restore 或 create session
   ├─ 装配 AgentLoop（注入 EventBus）
   ├─ bus.subscribe(sseWriter)        ← 唯一的新增接线
   └─ loop.run(message)

← event: session   {session_id}          （先发，客户端要立刻拿到会话号）
← event: delta     {text}                 逐块
← event: tool_start/tool_end/thinking
← event: blocked   {by, reason}
← event: response  {content}
← event: done      {tokens, cost_usd}     终端事件，必发
```

**终端事件保证**：v0.4 已经让 `blocked` 路径也 emit `done`。SSE 契约依赖这条 ——
客户端可以「收到 done 就关流」，不需要靠超时判断。

### ⚙️ 设计② 每请求装配，进程无会话状态

```ts
// 每个请求独立装配，AgentLoop 不跨请求复用
const session = sessionId
  ? await Session.restore(stores.sessions, sessionId)   // null → 404
  : await Session.create(stores.sessions, { userId, tenantId });
const loop = new AgentLoop({ ...deps, session, bus });
```

进程内**不缓存任何会话**。代价是每次请求要读一次库（v0.7 用 Redis 热缓存优化），
收益是**天然可水平扩容**：任意实例都能接任意请求。

### ⚙️ 设计③ CLI 降级为服务的瘦客户端

`npm start` 不再自己跑 Agent，而是连服务的 SSE。
这不是形式主义 —— 它**证明解耦真的成立**：如果 CLI 还能直接调 AgentLoop，
说明服务化只是加了一层壳，核心仍与传输方式耦合。

## 三、边界

### ✅ 本版做

| # | 事项 | 类型 |
|---|---|---|
| 1 | Fastify app 工厂（可注入 stores，便于测试） | 设计② |
| 2 | `POST /v1/chat` → SSE 流式 | 设计① |
| 3 | `POST /v1/chat/sync` → JSON 一次性返回（不支持 SSE 的调用方） | 设计① |
| 4 | `GET /v1/sessions/:id` → 会话元信息与消息数 | 🛒 |
| 5 | `GET /v1/sessions/:id/messages` → 完整对话历史 | 🛒 |
| 6 | `GET /healthz` → 健康检查（含存储连通性） | 🛒 |
| 7 | 请求体校验（TypeBox schema + Fastify 校验），400 明确报错 | 设计② |
| 8 | 错误契约：4xx/5xx 统一 JSON 形状 `{error: {code, message}}` | 设计② |
| 9 | sessionId 不存在 → **404**（不静默新建，否则表现为「模型突然失忆」） | 设计② |
| 10 | CLI 改为 SSE 瘦客户端（`npm start` 连服务） | 设计③ |
| 11 | 服务端入口 `npm run serve` | 设计③ |
| 12 | 客户端断连时中止本轮（不继续烧 token） | 设计② |

### ❌ 本版不做

| 事项 | 留给 | 理由 |
|---|---|---|
| 鉴权（API key / JWT） | v1.0 | 需要和租户模型一起设计，而租户模型在 v0.11 |
| 限流 | v0.11 | 与配额检测同属一个主题，用同一个 Redis 计数器 |
| WebSocket | 不做 | SSE 已覆盖需求；双向推送的实际场景（人工介入）在 v0.12 |
| Redis 会话热缓存 | v0.7 | 先证明「每请求读库」能跑通，再优化 |
| 多轮记忆 / 意图识别 / 多 Agent | v0.7-v0.9 | 本版不加 Agent 能力 |
| OpenAPI 文档生成 | v0.14 | — |

## 四、验收标准

| # | 判据 | 验证方式 |
|---|---|---|
| E1 | `POST /v1/chat` 返回 `text/event-stream`，事件序列以 `session` 开头、`done` 结尾 | `tests/server/chat.test.ts`（Fastify `inject`，不起真端口） |
| E2 | delta 事件在 response 之前，拼接 === response 内容 | 同上 |
| E3 | 不传 sessionId → 新建会话，响应头/首事件带 session_id | 同上 |
| E4 | 传已存在 sessionId → 续接上下文（第二轮能看到第一轮的消息） | 同上 |
| E5 | 传不存在的 sessionId → **404**，不新建 | 同上 |
| E6 | `POST /v1/chat/sync` 返回完整 JSON，含 reply / session_id / usage | 同上 |
| E7 | 请求体缺 `message` → 400，错误体含字段名 | 同上 |
| E8 | 注入攻击输入 → SSE 里出现 `blocked` 事件，且**不调用模型** | 同上 |
| E9 | `GET /v1/sessions/:id` 返回元信息；不存在 → 404 | `tests/server/sessions.test.ts` |
| E10 | `GET /healthz` 在存储可用时 200、不可用时 503 | 同上 |
| E11 | 用例数不净减（基线 **223**） | `npm run verify` |
| E12 | `npm run verify` exit 0 | — |

## 五、风险预判

| 风险 | 影响 | 缓解 |
|---|---|---|
| Fastify 的 SSE 需要手写响应流，容易漏掉 flush / 结束 | 客户端挂起 | 用 `reply.raw` 直写并显式 `end()`；用例断言完整事件序列而非只断言首事件 |
| 每请求开库连接会拖慢 | 延迟上升 | stores 在**进程启动时开一次**，请求间共享；不是每请求开库 |
| 客户端断连后 Loop 继续跑，白烧 token | 成本 | 监听 `request.raw.on('close')`，置中止标志；本版先做「停止写出 + 记录」，真正的中断 Loop 归 v1.0 韧性版 |
| CLI 改瘦客户端后，没起服务就用不了 | 开发体验变差 | `npm start` 检测不到服务时给出明确提示（含 `npm run serve` 指引），不是一个连接错误堆栈 |
| Fastify 5 的类型与 TypeBox 集成 | 编译报错 | 用 Fastify 原生 JSON Schema 校验，不引 `@fastify/type-provider-typebox`（少一个依赖） |
