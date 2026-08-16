# 好买电商 AI 客服 Agent

一个电商场景的对话式 AI 客服服务。**对外提供 HTTP/SSE 接口**，不是命令行玩具。

从 v0.1 到 v1.2 走了 17 个版本，每版都有 SPEC / PLAN / REPORT 存档在
[`docs/iterations/`](docs/iterations/)，总路线见 [`docs/ROADMAP.md`](docs/ROADMAP.md)。

**先读这两份**：[`docs/SUMMARY.md`](docs/SUMMARY.md)（17 版总结 + 缺陷账本）与
[`docs/ARCHITECTURE-REVIEW.md`](docs/ARCHITECTURE-REVIEW.md)（架构体检与差距清单）。

```
795 个用例 ｜ npm run verify exit 0 ｜ 离线评测 15/15 ｜ 三维回归门守着质量·成本·延迟
```

---

## 它能做什么

| 能力 | 说明 |
|---|---|
| **流式输出** | SSE 逐字吐出，首块延迟 ~24ms（非流式 ~613ms） |
| **多轮记忆** | 短期滑窗 + 中期摘要压缩 + 长期用户画像，跨会话持久化 |
| **多轮意图识别** | 9 类意图 + 槽位收集 + 状态机，识别失败自动降级不阻断对话 |
| **多 Agent 路由** | 售前/订单/售后/账户/通用五个领域 Agent，按意图分发并收窄工具面 |
| **文本安全** | 四级处置（放行/脱敏/拦截/转人工）+ **流式感知脱敏** + 审计留痕 |
| **计费与配额** | 持久化账本 + 两级配额（会话 200 / 租户 429）+ Redis 原子扣减 |
| **业务流** | 退货退款状态机，守卫 + 审批分档 + 全程流转留痕 |
| **异步确认** | 高风险操作生成确认单，客户确认后才执行；确认单一次性不可重放 |
| **结构化返回** | 工具产出 artifact（商品卡/订单卡/优惠券方案…），**不经过模型** |
| **多租户** | 账本、配额、售后政策、安全规则、**用户画像**均按租户隔离（规则只能加严） |
| **身份与边界** | API Key 认证（存哈希）+ scope + **租户只从凭证取** + 越权一律 404 |
| **防滥用** | 按凭证限流（429 + Retry-After）+ `Idempotency-Key`（重发不会重复退款） |
| **可观测** | Prometheus `/metrics` + **分布式追踪**（自研 span + OTLP 导出 + W3C traceparent）+ 离线评测集 + 三维回归门 |
| **明确的失败** | 轮次结果分 `ok/blocked/cancelled/error/max_turns`，带 `retryable`；**失败时 reply 是空串**，错误正文不冒充回复 |
| **会话一致性** | 会话独占锁，同一会话并发的第二轮 409 而不是把历史写交错 |
| **韧性** | 熔断 + 重试（高风险工具永不重试）+ 取消传播 + 优雅退出 |
| **可拆分** | 工具执行可作为独立服务，两种形态行为一致 |

## 快速开始

```bash
npm install
export ANTHROPIC_API_KEY=sk-...

npm run serve                                          # 启动服务（默认 3000）
npm run key:issue -- --tenant t_demo --scopes chat,read # 签一把凭证
```

**认证默认开启**。签发时明文只出现一次 —— 库里存的是 sha256 哈希，
丢了只能重新签发。本地开发想跳过可设 `AGENT_AUTH_DISABLED=1`（启动会打警告）。

**零配置即可跑**：不设 `DATABASE_URL` 时用 PGlite（PostgreSQL 编译成 WASM，跑在进程内），
不设 `REDIS_URL` 时自动降级为无缓存。要切真实 PG/Redis 只改环境变量，业务代码一行不动。

### 常用命令

```bash
npm run verify      # 类型检查 + 全部用例（src + tests + scripts 全覆盖）
npm run eval        # 离线评测 + 三维回归门（质量/成本/延迟）
npm run bench:stream # 首块延迟基准
npm run bench:quota  # 配额检查延迟与并发超发上限
npm run serve:tools  # 单独启动工具服务（拆分形态）
```

## 接口

```bash
# 流式对话
curl -N -X POST localhost:3000/v1/chat \
  -H 'Authorization: Bearer ak_live_...' \
  -H 'Content-Type: application/json' \
  -d '{"message":"我的订单 ORD-20260801-001 到哪了","user_id":"u1"}'

# 非流式 + 幂等键（超时重发不会重复执行）
curl -X POST localhost:3000/v1/chat/sync \
  -H 'Authorization: Bearer ak_live_...' \
  -H 'Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000' \
  -H 'Content-Type: application/json' \
  -d '{"message":"有什么电子产品"}'

# 租户号**不从请求体取** —— 它是凭证的属性。传了且与凭证不符会 403
```

SSE 事件：`session` / `intent` / `routing` / `safety` / `delta` / `thinking` /
`tool_start` / `tool_end` / `tool_rejected` / `artifact` / `confirmation_required` /
`quota` / `response` / `blocked` / `cancelled` / `error` / `done`

| 端点 | 用途 |
|---|---|
| `POST /v1/chat` · `/v1/chat/sync` | 对话（流式 / 非流式） |
| `GET /v1/sessions/:id` · `/messages` · `/artifacts` · `/confirmations` · `/safety-report` | 会话查询与回放 |
| `POST /v1/confirmations/:id` | 确认或拒绝高风险操作 |
| `GET /v1/flows/:id` | 退货退款流程进度与流转记录 |
| `GET` · `PUT /v1/tenants/:id/config` · `GET /v1/tenants/:id/usage` | 租户配置与用量 |
| `GET /v1/users/:id/profile` | 用户画像（长期记忆） |
| `GET /v1/agents` | 领域 Agent 列表 |
| `GET /v1/traces/:trace_id` | 本实例的链路 span（没有 collector 时也能看） |
| `GET /metrics` · `/healthz` | 指标、健康检查（**免认证**，不返回任何租户数据） |

权限：`chat` 发起对话 · `read` 读 · `write` 决策确认单/改配置 · `admin` 跨租户（运营后台）。
`admin` **不隐含**其余三者 —— 只做审计的管理端不该顺手能发起对话。

## 架构

```
                          ┌─────────────────────────────┐
   HTTP / SSE ───────────▶│        AgentLoop            │
                          │  规划 → 确认 → 并发执行 → 回喂 │
                          └──┬──────────────────────┬───┘
                             │                      │
              ┌──────────────▼───────────┐   ┌──────▼────────┐
              │        Pipeline          │   │  ToolGateway  │
              │  safety → 画像 → 意图     │   │ 本地 / 远程    │
              │  → 路由 → 压缩 → 裁剪     │   │ 熔断 + 重试    │
              │  → 配额                  │   └──────┬────────┘
              └──────────────────────────┘          │
                             │                      ▼
                       ┌─────▼──────┐        ┌─────────────┐
                       │  EventBus  │        │ 11 个工具    │
                       └─────┬──────┘        │ 订单/商品/退款│
            ┌────────────────┼────────┐      │ 物流/券/发票  │
            ▼                ▼        ▼      └─────────────┘
      SSE 写出器         指标采集   轨迹日志
```

**事件总线是这个架构最划算的一笔投资**：v0.4 把事件分发收敛到总线，
后面 SSE 写出器（v0.6）、安全事件（v0.10）、指标采集（v0.14）三次接入都是
「加一个订阅者」，`AgentLoop` 一行没改。

### 目录

| 目录 | 内容 |
|---|---|
| `src/core/` | AgentLoop、Pipeline、EventBus、Session、TokenTracker、ModelProvider |
| `src/middleware/` | safety / 画像 / 意图 / 路由 / 压缩 / 裁剪 / 配额 |
| `src/tools/` | 11 个工具 + 注册表 + **ToolGateway**（本地/远程） |
| `src/store/` | PG 存储层（会话/退款/画像/账本/流程/确认/租户配置） |
| `src/safety/` | 规则集、扫描器、**流式脱敏器** |
| `src/flows/` | 状态机引擎、退货退款流、异步确认 |
| `src/billing/` | 配额服务与计数器 |
| `src/observability/` | 指标注册表与采集器 |
| `src/evaluation/` | 评测用例、判定逻辑、回归门 |
| `src/resilience/` | 熔断器与重试 |
| `src/auth/` | Principal、API Key 生成与哈希 |
| `src/observability/tracing.ts` | Span / Tracer / OTLP 导出 / W3C traceparent |
| `src/tool-service/` | 独立工具服务 |

## 部署

见 [`deploy/README.md`](deploy/README.md)。两种形态：单进程（默认）与拆分
（设 `TOOL_SERVICE_URL`），**行为完全一致** —— 同一套用例跑两种网关验证过。

> ⚠️ Dockerfile 与 compose 文件**未经构建验证**（开发机无 Docker），首次部署请自行核对。

## 已知限制

| 限制 | 说明 |
|---|---|
| 评测只覆盖编排层 | 意图路由/工具选择/安全脱敏/结构化返回。**模型答案质量**需要真实 API + 人工评审，本仓库不做 |
| 并发配额有超发 | 「先检查后扣减」，超发上限 = 并发数 × 单轮用量，严格线性且可预测（`npm run bench:quota` 可测） |
| 误杀率是筛查线索不是真值 | 真误杀率需要人工标注，`/safety-report` 给的是拦截构成 |
| 基准数据为模拟 | 无 API key 时基准脚本用受控假 provider，输出标注 `[模拟]` |
| 商品/订单为样例数据 | `src/data/*.json`，接真实系统需替换 loader |
| 优惠券/发票未接外部系统 | 规则与产物是真的，落地需对接券中心与开票系统 |

## 这个项目值得读的地方

15 版里挖出并修掉的**「看起来在工作但实际没有」**，比新增的能力更有参考价值：

| 版本 | 发现 |
|---|---|
| v0.2 | 能力写好了但**没接进管道** —— 测试全绿，运行时零引用 |
| v0.5 | 用 `created_at` 排序：PG 的 `now()` 是事务开始时间，同毫秒记录顺序随机 |
| v0.6 | flaky 测试暴露的**真** bug —— flaky ≠ 加重试，它是并发缺陷的唯一自动信号 |
| v0.10 | 脱敏保护的是**返回值**，而用户看的是流 —— 未脱敏手机号早已打到屏幕上 |
| v0.11 | `maxTokensPerSession` 限的不是 session —— 计数器每请求新建，熔断永不触发 |
| v0.12 | 退款在服务端根本执行不了，且失败信息**谎称「用户取消」**，模型据此回「已处理」 |
| v0.13 | 对外只有文本 API，接入方只能正则解析模型的中文散文 |
| v0.14 | `ResponseScorer` 是假指标（越啰嗦分越高），且 13 个版本没人读过它 |
| v0.15 | `tool.execute` 是函数引用 —— 工具与编排绑死在同进程，是架构死结不是性能问题 |
| v1.1 | **`tenant_id` 由客户端声明** —— 多租户做了五个版本，租户身份却是请求体里的一个字符串 |
| v1.1 | 画像主键是 `user_id` 单列 —— 而 user_id 常是手机号，任何租户拿它就能读到别家客户的偏好与投诉记录 |
| v1.1 | 拆分形态下 `tool-service` 裸奔 —— 绕过主服务直接打它，v0.12 的高危确认流根本不存在 |
| v1.2 | `run()` 失败时把 `LLM调用失败: xxx` **当回复正文返回** —— CLI 逐字打给用户看 |
| v1.2 | 会话并发不是"覆盖写"而是**消息交错** —— 下一轮 restore 出来的历史直接是坏的，且延迟一轮才发作 |
| v1.2 | `/v1/traces` 归属判定第一版按「逐 span 过滤」，而 model/tool span 根本没有 tenant 属性 —— **默认放行 + 逐项排除，在数据缺失时会静默放行** |

共同点：**单元测试全绿，端到端行为是错的。** 抓住它们的唯一办法，
是沿着用户真实走的那条路从头跑一遍，并且**先把失效的样子固定成用例**再动手修。

## 技术栈

TypeScript 5.6 · tsx · Fastify 5 · PGlite/PostgreSQL · ioredis · TypeBox + Ajv ·
vitest · `@anthropic-ai/sdk`

**手写 Agent Loop，不用 LangChain 之类的框架** —— 循环编排是这个系统的核心资产，
它该是可读、可测、可改的代码，而不是配置。
