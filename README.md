# ecommerce-agent · 电商 AI 客服 Agent

一个**从零手写 Agent Loop** 的电商智能客服，不依赖 LangChain / LlamaIndex 之类框架，直接基于 `@anthropic-ai/sdk` 控制「模型 → 工具调用 → 结果回喂 → 再推理」的完整循环。

定位是**可读、可测、可拆的 Agent 工程骨架**：guardrails（输入输出过滤、预算熔断）、memory（上下文裁剪、用户画像）、evaluation（回答打分、轨迹落盘）从第一天就是独立模块，而不是事后补的补丁。

```
用户: 我的订单 ORD-20260801-001 到哪了？
  ↓
👤 → AgentLoop → Claude → tool_use(query_order) → 本地 JSON 查询
                    ↑                                    ↓
                    └────────── tool_result ─────────────┘
  ↓
🤖 您的订单已发货，顺丰 SF1234567890，预计明天送达。
```

---

## 快速开始

```bash
# Node.js ≥ 18
npm install

export ANTHROPIC_API_KEY=sk-ant-...      # 必需，缺失直接退出
export AGENT_MODEL=claude-opus-5         # 可选，默认见下方「配置」

npm start          # 交互式 CLI，输入 exit / quit 退出
npm test           # vitest run —— 79 个用例 / 12 个测试文件
npm run test:watch # 监听模式
npx tsc --noEmit   # 类型检查
```

CLI 退出时自动打印本次会话的 token 与成本汇总（输入/输出 token、API 调用次数、总成本 USD、缓存读取量）。

---

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│  index.ts —— CLI 入口                                        │
│  · readline 交互  · 事件渲染(💭🔧✅🤖❌)  · 高风险操作确认(y/n) │
│  · 内联定义 4 个工具  · 退出时打印成本汇总                     │
└────────────────────────────┬────────────────────────────────┘
                             │ AgentEvent 回调 + ConfirmHandler
┌────────────────────────────▼────────────────────────────────┐
│  core/agent-loop.ts —— 循环控制器（唯一的编排中心）           │
│                                                              │
│   while (turns < maxTurns)                                   │
│     ├─ ① 预算检查 tracker.isOverBudget() ──超支→ 中止        │
│     ├─ ② provider.chat(system, messages, tools)              │
│     ├─ ③ tracker.add(usage, model)  记账                     │
│     ├─ ④ 纯文本回复 → emit response + done → return          │
│     └─ ⑤ 有 tool_use：                                       │
│          ajv 校验参数 → riskLevel==='high' 则请求确认         │
│          → tool.execute() → 结果作为 tool 消息回喂 → continue │
└───┬──────────────┬──────────────┬───────────────────────────┘
    │              │              │
┌───▼──────┐ ┌─────▼──────┐ ┌────▼──────────┐
│ model-   │ │ token-     │ │ session.ts    │
│ provider │ │ tracker    │ │ JSONL 落盘    │
│ 消息格式  │ │ 内置价格表  │ │ create/restore│
│ 双向转换  │ │ 成本累计    │ │ 损坏行跳过    │
└──────────┘ └────────────┘ └───────────────┘
```

**关键设计点**

| 决策 | 理由 |
|---|---|
| 手写 Loop 而非用框架 | 循环终止、预算熔断、工具确认这三件事全在 `agent-loop.ts` 的一个 `while` 里，出问题能一眼定位；框架的抽象层在 Agent 场景下经常是负债 |
| `AgentEvent` 事件流与渲染解耦 | Loop 只 emit `thinking / tool_start / tool_end / response / error / done`，CLI 负责渲染。换 Web / IM 端只需换 `EventHandler` |
| 工具带 `riskLevel` | `high` 级工具（退款）执行前走 `ConfirmHandler` 阻塞确认，权限门在 Loop 层而非工具内部 |
| Session 用 JSONL 追加写 | 每条 entry 独立一行、`appendFileSync` 即时落盘；进程崩溃最多丢最后一行，`loadFromFile` 遇到解析失败的行跳过并告警 |
| 工具参数用 TypeBox → JSON Schema | 同一份 schema 既喂给 Claude 做 tool 定义，又给 ajv 做运行时校验，不用维护两套 |

---

## 目录结构

```
src/
├── index.ts                      280 行 · CLI 入口 + 内联 4 个工具定义 + 成本汇总
├── core/
│   ├── agent-loop.ts             267 行 · ⭐ 循环控制器（预算/校验/确认/执行/回喂）
│   ├── model-provider.ts         133 行 · Anthropic SDK 封装，内部消息 ⇄ API 格式转换
│   ├── session.ts                128 行 · JSONL 会话持久化（create/restore/list）
│   ├── token-tracker.ts           92 行 · token 累计 + 内置价格表算成本
│   └── types.ts                   90 行 · 全部公共类型（Message/AgentTool/AgentEvent…）
├── tools/                        ⚠️ 见下方「两套工具实现」
│   ├── tool-registry.ts           59 行 · 工具注册表（register/get/getAll/executeTool）
│   ├── order-lookup.ts            55 行 · 订单号 / 手机号后 4 位查询
│   ├── product-search.ts          76 行 · 关键词 + 分类 + 价格区间，Top 5
│   ├── faq-search.ts              59 行 · 加权打分（问题+3 / 答案+1 / 分类+2），Top 3
│   ├── refund-apply.ts            56 行 · 生成退款工单号（high risk）
│   └── human-handoff.ts           24 行 · 转人工，按优先级给等待时长（medium risk）
├── guardrails/                   ⚠️ 已实现 + 已测试，尚未接入运行时
│   ├── input-filter.ts            34 行 · 5 条 prompt injection 正则（忽略指令/伪造 system/角色劫持…）
│   ├── output-filter.ts           31 行 · 手机号 / 身份证 / sk- 密钥脱敏
│   └── budget-guard.ts            46 行 · 用量比例计算 + 80% 预警 + 100% 拒绝
├── memory/                       ⚠️ 同上
│   ├── context-manager.ts         22 行 · 保留 system + 最近 N 条消息
│   └── user-profile.ts            19 行 · 内存态用户画像 Map
├── evaluation/                   ⚠️ 同上
│   ├── response-scorer.ts         26 行 · 启发式三维打分（相关性/有用性/准确性）
│   └── trajectory-logger.ts       20 行 · AgentEvent 逐条落盘
├── prompts/system-prompt.ts       24 行 · 角色 / 工具说明 / 使用规则 / 回答风格
└── data/                         Mock 数据（见下）

tests/                            12 个文件 · 79 个用例
sessions/                         运行时生成的 *.jsonl 会话轨迹
```

---

## ⚠️ 两套工具实现（读代码前必看）

当前仓库里有**两套并行的工具实现，只有一套真正在跑**：

| | `src/index.ts` 内联定义 | `src/tools/*.ts` 模块 |
|---|---|---|
| 工具名 | `query_order` / `search_products` / `search_faq` / `apply_refund` | `order_lookup` / `product_search` / `faq_search` / `refund_apply` / `human_handoff` |
| Schema | TypeBox（`Type.Object`） | 手写 JSON Schema 字面量 |
| 数据加载 | 启动时 `require()` 一次，常驻内存 | 每次调用 `readFileSync` 重读 |
| **运行时是否生效** | ✅ **是**，`main()` 里注册进 AgentLoop | ❌ **否**，没有任何运行时引用 |
| **是否被测试覆盖** | ❌ 否 | ✅ 是，`tests/` 测的全是这一套 |

同理，`guardrails/`、`memory/`、`evaluation/`、`tools/tool-registry.ts` 也都**只被测试引用，没有接入 `agent-loop.ts` 或 `index.ts`**。可用一行验证：

```bash
grep -rn --include='*.ts' -E "from '\./(tools|guardrails|memory|evaluation)/" src/ | grep -v '^src/\(tools\|guardrails\|memory\|evaluation\)/'
# 输出为空 —— 运行时零引用
```

**这意味着**：prompt injection 过滤、PII 脱敏、预算预警、上下文裁剪、轨迹打分这些能力目前是「写好了但没通电」。测试全绿 ≠ 线上生效。接线是当前第一优先级，见下方「已知限制」。

---

## Mock 数据

无外部依赖，全部走本地 JSON（`src/data/`）：

| 文件 | 条数 | 字段 |
|---|---|---|
| `orders.json` | 10 | `orderId` `phone` `customerName` `items[]` `totalAmount` `status` `createTime` `tracking` `address` |
| `products.json` | 20 | `productId` `name` `category` `price` `stock` `description` `rating` |
| `faqs.json` | 15 | `id` `question` `answer` `category` |

- 订单状态：`pending` / `paid` / `shipped` / `delivered` / `refunded`（`cancelled` 在状态映射表里有，数据中暂无）
- 商品分类：`电子产品` / `服饰` / `食品`
- FAQ 分类：退换货 / 配送 / 支付 / 会员 / 发票 / 优惠活动 / 订单 / 客服

---

## 配置

配置通过环境变量注入，在 `index.ts` 的 `main()` 里组装成 `AgentConfig`：

| 字段 | 环境变量 | 当前默认值 | 说明 |
|---|---|---|---|
| `apiKey` | `ANTHROPIC_API_KEY` | 无（缺失即退出） | Anthropic API Key |
| `model` | `AGENT_MODEL` | `claude-sonnet-4-20250514` | ⚠️ 该型号已进入 deprecated（2026-06-15 退役），建议显式设为 `claude-opus-5` 或 `claude-sonnet-5` |
| `maxTurns` | — | `10` | 单次 `run()` 内最大循环轮次，防止工具调用死循环 |
| `maxTokensPerSession` | — | `100_000` | 会话累计 token 上限，每轮开头检查，超限中止并提示开新会话 |
| `confirmHighRisk` | — | `true` | `riskLevel === 'high'` 的工具执行前是否阻塞确认 |
| `systemPrompt` | — | `prompts/system-prompt.ts` | — |

`core/token-tracker.ts` 内置价格表（USD / 1M tokens）目前只收录 Claude 4 系列，未命中时回落到 `{ input: 3, output: 15 }`。换用 Claude 5 系列模型需要同步补价格，否则成本汇总会算错。

---

## 测试

```
$ npm test
 ✓ tests/token-tracker.test.ts    (10)     ✓ tests/response-scorer.test.ts  (8)
 ✓ tests/output-filter.test.ts     (6)     ✓ tests/product-search.test.ts   (5)
 ✓ tests/user-profile.test.ts      (5)     ✓ tests/faq-search.test.ts       (4)
 ✓ tests/budget-guard.test.ts      (7)     ✓ tests/session.test.ts          (9)
 ✓ tests/input-filter.test.ts      (8)     ✓ tests/tool-registry.test.ts    (7)
 ✓ tests/context-manager.test.ts   (6)     ✓ tests/order-lookup.test.ts     (4)

 Test Files  12 passed (12)
      Tests  79 passed (79)
```

覆盖的是**纯函数与单模块行为**：token 记账与成本计算、会话读写与损坏行恢复、三个 guardrail 的判定、上下文裁剪边界、工具的查询/过滤/打分逻辑、注册表的校验与错误封装。

**没有覆盖**：`agent-loop.ts` 的循环编排（无测试文件）、`model-provider.ts` 的消息格式转换（无测试文件）、`index.ts` 内联的那 4 个真正在跑的工具。这两个是整套系统最核心也最容易出错的地方 —— 补测优先级最高。

---

## 已知限制

按影响面排序，都是读代码时能核实的事实：

### 🔴 只能处理单个 tool_use，并行工具调用会打断对话

`model-provider.ts` 用 `let toolUse: ToolUse | undefined` 收集响应块，循环里后者覆盖前者。Claude 默认开启 parallel tool use，一次响应可能返回多个 `tool_use` 块 —— 此时只有最后一个被保留并执行，其余静默丢弃。而 API 要求每个 `tool_use` 都必须有对应的 `tool_result`，下一轮请求会因缺失配对而报错。

修法：`toolUse?: ToolUse` 改成 `toolUses: ToolUse[]`，Loop 里遍历执行、把所有 `tool_result` 放进**同一条** user 消息回喂。

### 🔴 Session.restore 恢复出的历史是残缺的

`agent-loop.ts` 在工具执行成功路径上，把 tool 结果 push 进了内存态 `conversationMessages`，但只调了 `session.appendToolResult()`（写的是 `tool_result` 类型 entry），**没有调 `session.appendMessage()`**。而 `Session.getMessages()` 只筛 `type === 'message'` 的 entry。

结果：落盘的消息序列里有带 `tool_use` 的 assistant 消息，却没有对应的 tool 结果消息。用 `Session.restore()` 恢复后首次请求必然被 API 拒绝。目前 `index.ts` 只用 `Session.create()`，所以这个坑还没被踩到。

### 🟡 上下文无裁剪，长会话必然撞预算

`context-manager.ts` 写好了却没接。`conversationMessages` 只增不减，每轮把全量历史重发一遍，input token 随轮次二次增长，最终由 `maxTokensPerSession` 硬熔断。接入 `ContextManager.trimMessages()` 是最直接的修法。

若要进一步降本，可评估 prompt caching：system prompt + 4 个工具定义是稳定前缀，但缓存有最小前缀长度门槛（按模型 512～4096 tokens），当前前缀是否够长需要先用 `client.messages.count_tokens()` 量一次再决定，不要凭感觉加 `cache_control`。

### 🟡 退款工具两套实现，两种缺陷

- `index.ts` 内联版：会检查 `refunded` / `pending` 状态，但直接改 `require()` 回来的内存对象（`order.status = 'refunded'`），改动进程内可见、不落盘，重启即失效。
- `tools/refund-apply.ts`：每次重读文件、只挡 `pending`、**不检查已退款状态**，同一订单可反复提交退款工单。

真实场景下退款必须走幂等：以订单号 + 状态做前置校验，并把结果持久化。

### 🟡 tools/product-search.ts 两处与数据不符

- `metadata.productIds` 取的是 `p.id`，而 `products.json` 的主键字段名是 `productId` → 该数组实际是 `[undefined, ...]`。
- 工具 description 写的分类示例是「耳机、配件」，而真实数据分类是「电子产品 / 服饰 / 食品」。description 是模型选参数的唯一依据，写错会直接导致空结果。

### 🟡 模型与价格表需要更新

默认模型 `claude-sonnet-4-20250514` 已 deprecated（2026-06-15 退役）。`token-tracker.ts` 的价格表也只有 Claude 4 系列，切到 Claude 5 系列后会静默回落到默认价格，成本数字不可信。

### 🟢 无流式输出

`model-provider.ts` 走 `messages.create()` 非流式，用户在模型生成期间只能干等。`AgentEvent` 的事件设计已经为流式预留了位置（`thinking` 事件），换 `messages.stream()` 改动面可控。

---

## 下一步建议顺序

1. **接线**：把 `guardrails/` `memory/` `evaluation/` 接进 `agent-loop.ts`（输入进 Loop 前过 `InputFilter`，回复出 Loop 前过 `OutputFilter`，每轮前跑 `ContextManager.trimMessages()`）
2. **统一工具**：删掉 `index.ts` 的内联定义，改用 `tools/*.ts` + `ToolRegistry`，让测试覆盖的那一套成为真正在跑的那一套
3. **补核心测试**：`agent-loop.ts`（mock ModelProvider 断言循环终止、预算熔断、确认拒绝、工具报错回喂）、`model-provider.ts`（消息格式转换往返）
4. **修 parallel tool use 与 Session.restore** 两个 🔴
5. **升级模型 + 补价格表**，再考虑流式与 prompt caching
