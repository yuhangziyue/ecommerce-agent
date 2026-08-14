# v0.3 · 核心链路正确性（Correctness）

> 起点：`ce8dca4`（v0.2）｜ 前置：v0.2 已让 AgentLoop 可测 ｜ 后继：v0.4 流式输出

---

## 一、迭代目的

**v0.2 让核心可测，v0.3 用这个能力去修此前不敢碰的两个真 bug。**

顺序不能反：并行工具调用要改的是 `while` 循环最核心的分支，`Session.restore` 要改的是历史重建逻辑。
在没有 21 条 agent-loop 用例兜底之前改这两处，等于闭着眼睛做心脏手术。现在有了。

四个缺陷的实际风险：

1. **🔴 并行工具调用丢块 —— 会让对话彻底卡死，不是降级。**
   `model-provider.ts` 用 `let toolUse: ToolUse | undefined` 收集响应块，后者覆盖前者。
   Claude 默认开启 parallel tool use（一次响应可含多个 `tool_use`），此时只有最后一个被执行，
   其余静默丢弃。而 Anthropic API 要求**每个 `tool_use` 必须有配对的 `tool_result`** ——
   下一轮请求因缺配对被拒（400），整轮对话中断。用户看到的是"客服突然不说话了"。

2. **🔴 `Session.restore()` 恢复出的历史必然非法。**
   `getMessages()` 只筛 `type === 'message'` 的 entry，而工具结果走的是 `appendToolResult()`
   写入的 `tool_result` entry。落盘序列里有带 `tool_use` 的 assistant 消息，却没有对应的
   tool 结果消息 → restore 后首次请求必被 API 拒绝。
   目前 `index.ts` 只用 `Session.create()` 所以还没踩到 —— 但 v0.6 服务化后，
   **每个 HTTP 请求都要靠 sessionId 恢复上下文**，这个 bug 会从"潜伏"变成"必现"。

3. **🟡 退款非幂等。** 同一订单可反复提交退款工单，每次生成新工单号。
   真实业务里这是资金风险，也是客服投诉的高发点。

4. **🟡 默认模型已 deprecated + 价格表过期。**
   `claude-sonnet-4-20250514` 于 2026-06-15 退役；`MODEL_PRICING` 只有 Claude 4 系列，
   换用 Claude 5 系列会静默回落到默认价格 → 成本数字不可信，而 v0.11 的计费账本要以此为基础。

## 二、核心设计（2 项）

### ⚙️ 设计① 并行工具调用：内部模型保持简单，合并发生在传输层

关键取舍：**不把「多个 tool_result 塞进一条消息」这件事泄漏到内部数据模型里。**

```
内部表示（Message[]）                    发给 API 的形态
─────────────────────────               ──────────────────────────────
assistant { toolUses: [A, B] }    ──▶   assistant [text?, tool_use A, tool_use B]
tool      { toolResult: A结果 }   ──┐
tool      { toolResult: B结果 }   ──┴▶   user [tool_result A, tool_result B]   ← 合并成一条
```

- `Message.toolUses?: ToolUse[]`（复数）：一个 assistant 轮次可能发起多个工具调用
- 工具结果仍是 **N 条独立的 tool 消息**：便于逐条落盘、逐条计时、逐条审计
- `messagesToAnthropicFormat` 负责把**连续的** tool 消息合并成一条 user 消息

为什么必须合并成一条：把多个 `tool_result` 拆到多条 user 消息里发出，会训练模型停止做并行调用
（Anthropic 文档明确指出这一点）。性能收益会被自己作废。

执行策略：**低风险工具并发执行，高风险工具串行确认**。
并发用 `Promise.all` —— 3 个查询工具串行是 3 倍延迟，而它们之间没有依赖。
但高风险确认必须串行：同时弹 3 个确认框，用户不知道自己在批准什么。

### ⚙️ 设计② Session 是事件流，`getMessages()` 是投影而非过滤

`getMessages()` 当前实现是 `entries.filter(e => e.type === 'message')` —— 这是**过滤**。
事件溯源的正确做法是**投影**：按顺序走完整个 entry 流，把每种事件映射成对话状态的一部分。

```ts
// 投影规则
'message'     → 原样作为 Message
'tool_result' → 合成一条 role:'tool' 的 Message（这是此前丢失的部分）
'tool_call'   → 跳过（信息已包含在 assistant 消息的 toolUses 里，重复投影会造成双计）
'metadata'    → 跳过（不是对话内容）
```

收益：不需要在 `appendToolResult` 之外再重复写一条 `message` entry（避免 JSONL 里同一份数据存两遍），
`restore()` 出来的历史天然与运行时一致。

## 三、边界

### ✅ 本版做

| # | 事项 | 类型 |
|---|---|---|
| 1 | `ChatResponse.toolUses: ToolUse[]`、`Message.toolUses?: ToolUse[]`（单数改复数） | 设计① |
| 2 | `model-provider` 收集全部 `tool_use` 块 | 设计① |
| 3 | `messagesToAnthropicFormat` 合并连续 tool 消息为单条 user 消息 | 设计① |
| 4 | `AgentLoop` 遍历执行多工具：低风险并发、高风险串行确认 | 设计① |
| 5 | `Session.getMessages()` 改为全 entry 流投影 | 设计② |
| 6 | `Session.restore()` 往返测试：恢复出的历史必须 API 合法 | 设计② |
| 7 | 退款幂等：`RefundStore`（进程内，按 orderId 去重） | 缺陷 3 |
| 8 | 默认模型 → `claude-opus-5`；`MODEL_PRICING` 补 Claude 5 系列（**保留** Claude 4 条目） | 缺陷 4 |
| 9 | 补测试：并行工具、合并形态、restore 往返、退款幂等、新模型价格 | 测试 |

### ❌ 本版不做

| 事项 | 留给 | 理由 |
|---|---|---|
| 流式输出 | v0.4 | 改 `ModelProvider` 的调用方式，与本版改响应解析冲突面大，分开做 |
| 退款工单落库（PG） | v0.5 | 本版用进程内 store，接口先定好，v0.5 换实现 |
| adaptive thinking / effort 参数 | v0.4 | 与流式一起调，属于「模型调用方式」范畴 |
| prompt caching | v0.7 | 需要先量 `count_tokens` 确认前缀够不够缓存门槛（512~4096） |
| 多租户计费账本 | v0.11 | 本版只保证单会话成本数字正确 |

## 四、验收标准

| # | 判据 | 验证方式 |
|---|---|---|
| B1 | 一次响应含 3 个 `tool_use` 时，3 个工具全部被执行 | `tests/agent-loop.test.ts` 断言 3 个 execute 均被调用 |
| B2 | 多个 `tool_result` 被合并成**一条** user 消息发出 | `tests/model-provider.test.ts` 断言 `out.length` 与块数 |
| B3 | 低风险工具并发执行（总耗时 ≈ 单个耗时，而非累加） | 3 个各 sleep 50ms 的工具，总耗时 < 120ms |
| B4 | 高风险工具串行确认，逐个询问 | 断言 `onConfirm` 调用次数与顺序 |
| B5 | 混合场景：高风险被拒时其余工具仍正常执行，且每个 tool_use 都有配对结果 | 断言结果数 === toolUses 数 |
| B6 | `Session.restore()` 后 `getMessages()` 含 tool 消息，且每条都能配对上 tool_use | `tests/session.test.ts` 不变量断言 |
| B7 | restore 出的历史喂给 `messagesToAnthropicFormat` 不产生孤立 tool_result | 往返测试 |
| B8 | 同一订单重复退款返回同一工单号，不新建 | `tests/refund-apply.test.ts` |
| B9 | `claude-opus-5` 成本按 $5/$25 计算；旧模型价格不变 | `tests/token-tracker.test.ts` |
| B10 | 全部测试通过，用例数不净减（基线 142） | `npm test` |
| B11 | `tsc --noEmit` exit 0 | — |

## 五、风险预判

| 风险 | 影响 | 缓解 |
|---|---|---|
| `Message.toolUse` → `toolUses` 是破坏性改名，多处测试用到 | `context-manager.test.ts`（2 处）、`model-provider.test.ts`（4 处）、`agent-loop.test.ts` 的 `toolReply` 助手 | 一次改完并全量复跑；这些是本项目自己的测试，非外部消费者 |
| 并发执行工具后，工具结果的**顺序**必须与 tool_use 顺序一致 | 顺序错乱会让模型把结果配错工具 | 用 `Promise.all` 保序（它按输入数组顺序返回），并加断言 |
| `getMessages()` 投影后，v0.2 的 agent-loop 会在 restore 场景下拿到更多消息 | 可能影响 `conversationMessages` 初始化 | restore 往返测试专门覆盖 |
| 幂等 store 是进程内的，重启即失效 | 重启后同一订单仍可重复退款 | 在 `RefundStore` 接口注释里写明，v0.5 换 PG 实现；本版不宣称"生产级幂等" |
