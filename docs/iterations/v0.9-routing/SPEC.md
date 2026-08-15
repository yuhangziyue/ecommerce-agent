# v0.9 · 多 Agent 路由（Routing）

> 起点 `ed53ddf`（v0.8）｜ 后继 v0.10 文本安全检测
> 输入是 v0.8 的意图输出。**注意：本版是进程内路由，物理拆服务在 v0.15。**

---

## 一、迭代目的

现在是「一个模型 + 一份 system prompt + 全部 5 个工具」。随着场景扩容（v0.12/v0.13 还要加），
这个单体 Agent 会遇到三个具体问题：

1. **提示词互相稀释** —— 退款的严谨要求、售前的推荐话术、投诉的安抚原则挤在同一份
   system prompt 里，每条都被别的条目稀释。加得越多，每条越不被遵守。
2. **工具面过宽** —— 客户问「有什么好耳机」时，`refund_apply`（高风险）也在工具列表里。
   工具越多，模型选错的概率越高，而选错高风险工具的代价不对称。
3. **无法差异化配置** —— 售前可以用便宜快的模型，退款必须用最强的；单体没有这个维度。

## 二、核心设计

### ⚙️ 设计① 领域 Agent = 提示词 + 工具子集 + 意图归属

```
DomainAgent {
  id, name, description
  intents:     Intent[]      ← 该领域负责哪些意图
  systemPrompt: string       ← 只写本领域的规则，不被别的领域稀释
  toolNames:   string[]      ← 只给本领域需要的工具
}
```

五个领域（覆盖 v0.8 的 9 类意图）：

| Agent | 负责意图 | 工具 |
|---|---|---|
| `presale` 售前 | `product_search` `chitchat` | product_search, faq_search |
| `order` 订单 | `order_query` `logistics` | order_lookup, faq_search |
| `aftersale` 售后 | `after_sales` `refund` | order_lookup, refund_apply, faq_search, human_handoff |
| `account` 账户 | `account` | faq_search, human_handoff |
| `general` 兜底 | `unknown` `complaint` | **全部工具** |

**`general` 拿全部工具是刻意的**：意图识别不出来时，收窄工具面等于让 Agent 更无能。
兜底路径应该保持 v0.8 的能力，而不是比它更弱。

### ⚙️ 设计② 路由是「每轮」的，不是「每会话」的

客户可能在一次会话里从售前聊到下单再到售后。路由必须跟着意图走，
所以它是 `enrich` 阶段的一个中间件，产出两样东西：

- `ctx.systemAppends.push(agent.systemPrompt)` —— 本轮的领域规则
- `ctx.allowedTools = agent.toolNames` —— 本轮可见的工具子集（新增扩展点）

`AgentLoop` 在调模型前按 `ctx.allowedTools` 过滤注册表。**注册表本身不变** ——
过滤只影响这一轮发给模型的工具列表，不影响工具的注册与执行。

### ⚙️ 设计③ 工具收窄不能改变执行语义

模型如果（因为历史消息里有）调用了不在本轮子集里的工具，**仍然正常执行**。

理由：收窄是**引导**（减少选错概率），不是**权限控制**。如果收窄同时变成鉴权，
那么一次意图误判就会让合法请求失败 —— 而 v0.8 明确写了意图识别可能出错。
真正的权限控制（谁能调退款）属于 v1.0 的鉴权范畴。

## 三、边界

### ✅ 本版做

| # | 事项 | 类型 |
|---|---|---|
| 1 | `DomainAgent` 类型 + `AgentRegistry`（按意图解析） | 设计① |
| 2 | 五个领域 Agent 定义（提示词 + 工具子集） | 设计① |
| 3 | `ctx.allowedTools` 扩展点；`AgentLoop` 按它过滤发给模型的工具 | 设计② |
| 4 | `routing` 中间件：意图 → Agent → 注入提示词与工具子集 | 设计② |
| 5 | 路由结果落 `ctx.metadata` 并经 SSE `routing` 事件暴露 | 🛒 |
| 6 | 未命中任何领域 → `general` 兜底（全工具） | 设计① |
| 7 | 工具收窄不改变执行语义（不在子集里的工具仍可执行） | 设计③ |
| 8 | `GET /v1/agents` 列出已注册领域 Agent | 🛒 |

### ❌ 本版不做

| 事项 | 留给 | 理由 |
|---|---|---|
| 物理拆分成独立服务 | v0.15 | 边界要先在单进程里验证 6 个版本 |
| 每个领域配不同模型 | v0.14 | 需要评测基线才能判断换模型是否掉点 |
| Agent 间显式移交（handoff 协议） | v0.12 | 属于多步业务流的范畴 |
| 基于工具的权限控制 | v1.0 | 与鉴权一起设计 |
| 路由准确率评测 | v0.14 | — |

## 四、验收标准

| # | 判据 | 验证方式 |
|---|---|---|
| H1 | 按意图解析到正确的领域 Agent | `tests/agents/routing.test.ts` |
| H2 | 未知意图 → `general` 兜底，且工具是**全集** | 同上 |
| H3 | 每个意图都有归属（不存在无人认领的意图） | 遍历全部 Intent 断言 |
| H4 | 领域提示词进入 `systemAppends` | 同上 |
| H5 | `ctx.allowedTools` 被设置为该领域的工具子集 | 同上 |
| H6 | `AgentLoop` 只把子集内的工具发给模型 | `tests/agent-loop.test.ts` |
| H7 | **不在子集里的工具仍可执行**（收窄是引导不是鉴权） | 同上 |
| H8 | 售前场景看不到 `refund_apply`（高风险工具不出现在无关场景） | 同上 |
| H9 | SSE 出现 `routing` 事件 | `tests/server/chat.test.ts` |
| H10 | `GET /v1/agents` 返回领域列表 | `tests/server/sessions.test.ts` |
| H11 | 用例数不净减（基线 **321**） | `npm run verify` |
| H12 | `npm run verify` exit 0 | — |

## 五、风险预判

| 风险 | 影响 | 缓解 |
|---|---|---|
| 意图误判导致路由到错误领域，工具不够用 | 请求失败 | 设计③：不在子集里的工具**仍可执行**；且 `unknown` 走全工具兜底 |
| 领域提示词与基础 system prompt 冲突 | 模型困惑 | 领域提示词只写**本领域特有**的规则，基础规则留在 `SYSTEM_PROMPT` |
| 会话中途切换领域，上下文里混着上个领域的内容 | 串线 | v0.8 的切换检测已注入「旧话题信息不要带入」提示 |
| 路由在 `enrich` 阶段，必须排在 `intent` 之后 | 拿不到意图 | 同一 `enrich` 数组内按顺序排列，并在类型注释写明依赖 |
