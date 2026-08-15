# v0.4 · 流式输出（Streaming）

> 起点 `5103a24`（v0.3 + 评审落地）｜ 后继 v0.5 存储层
> **这是十五个版本里第一个终端用户能直接感知的交付。**

---

## 一、迭代目的

v0.2 接线、v0.3 修正确性 —— 连续两版对用户零可感知产出。评审明确指出**这是最后一版可以"只修不给"**。

当前用户体验：提问后**完全静默**，直到模型生成完毕才一次性看到全部文字。
模型要调工具时更糟 —— 查订单、查商品、再组织回答，中间几秒到十几秒屏幕上什么都没有，
用户不知道是在处理还是卡死了。

流式输出把「等全量」变成「等首块」。这不是性能优化，是**可用性问题**：
感知等待时间由首字延迟主导，不由总时长主导。

同时补一个架构前置：v0.6 要做 SSE 服务时，事件需要**多个订阅者**
（SSE 写出 + 轨迹落盘 + 后续的指标埋点）。现在的 `onEvent` 单回调 + `trajectory?.log()`
是两套并行机制，再加订阅者就要改 Loop。本版一并收敛成 EventBus。

## 二、核心设计

### ⚙️ 设计① 始终流式，delta 事件可选消费

`ModelProvider` 内部**一律**用 `messages.stream()`，不再用 `messages.create()`。

理由不只是体验：非流式请求在 `max_tokens` 较大时会撞 SDK 的 HTTP 超时，
而 v0.12 的多步业务流、v0.13 的结构化返回都会推高输出长度。**流式是更安全的默认值。**

```
ChatProvider.chat(system, messages, tools, opts?: { onDelta?(text: string): void })
                                            └─ 给了就逐块回调，不给就只等最终结果
```

调用方不关心流式细节：`chat()` 的返回值仍是完整的 `ChatResponse`。
AgentLoop 传入的 `onDelta` 把文本块转成 `{ type: 'delta', text }` 事件发到总线。

### ⚙️ 设计② EventBus 取代单回调

```
                    ┌─▶ CLI 渲染器（v0.4）
AgentLoop ─emit─▶ EventBus ─┼─▶ TrajectoryLogger（v0.4，从 Loop 里的硬编码挪出来）
                    ├─▶ SSE 写出器（v0.6）
                    └─▶ 指标埋点（v0.14）
```

订阅者互不知情，加订阅者不改 Loop。这是 v0.6 服务化的前置。

## 三、边界

### ✅ 本版做

| # | 事项 | 类型 |
|---|---|---|
| 1 | `EventBus`（subscribe / unsubscribe / emit，订阅者异常隔离） | 设计② |
| 2 | `AgentLoop` 改用 EventBus；`trajectory` 从构造依赖变成一个订阅者 | 设计② |
| 3 | `AgentEvent` 增 `{ type: 'delta'; text: string }` | 设计① |
| 4 | `ModelProvider` 改用 `messages.stream()` + `finalMessage()` | 设计① |
| 5 | `ChatProvider.chat` 增可选 `opts.onDelta` | 设计① |
| 6 | CLI 逐块渲染（不再等全量才打印） | 🛒 场景 |
| 7 | 延迟基准脚本 `scripts/bench-streaming.ts`：无 key 用受控假 provider，有 key 打真实 API | 🛒 验收 |
| 8 | 承接 v0.3 评审：`resolvePricing` 回退方向与注释相反 | 🔧 |
| 9 | 承接 v0.3 评审：价格窗口重叠/缝隙无校验 | 🔧 |
| 10 | 承接 v0.3 评审：UTC 边界假设写进 `PriceWindow` 契约注释 | 🔧 |

### ❌ 本版不做

| 事项 | 留给 | 理由 |
|---|---|---|
| HTTP / SSE 服务 | v0.6 | 本版只把事件流准备好，传输层是下一版 |
| PostgreSQL / Redis | v0.5 | — |
| 缓存 token 计价、摘 `as any` | v0.7 | 缓存未开启，现在补是无靶子打枪 |
| adaptive thinking / effort 参数 | v0.7 | 与 prompt caching 一起评估，都属「模型调用参数调优」 |
| 工具调用的流式（`input_json_delta`） | v0.13 | 工具参数逐块渲染只在结构化返回协议里才有意义 |

## 四、验收标准

**用户可感知判据（C1 必须有真实数字，不接受只有内部判据）**

| # | 判据 | 验证方式 |
|---|---|---|
| **C1** | **首块延迟 vs 全量延迟的实测对比**，给出数字与倍数 | `npm run bench:stream` 输出表格 |
| C2 | 首个 `delta` 事件在 `response` 事件**之前**发出（结构性保证，不依赖墙钟） | `tests/agent-loop.test.ts` 断言事件顺序 |
| C3 | 所有 `delta` 拼接 === 最终 `response` 内容 | 同上 |
| C4 | 未提供 `onDelta` 时行为与 v0.3 完全一致（向后兼容） | 既有 178 条用例不许碰红 |
| C5 | EventBus 一个订阅者抛异常不影响其他订阅者，也不中断 Loop | `tests/event-bus.test.ts` |
| C6 | `unsubscribe` 后不再收到事件 | 同上 |
| C7 | `resolvePricing` 对早于所有窗口的调用用**最早**窗口，晚于的用**最晚**窗口；两种回退都可被识别 | `tests/token-tracker.test.ts` |
| C8 | 价格窗口的有序性/无重叠/无缝隙有自动校验 | 同上 |
| C9 | 全部测试通过，用例数不净减（基线 **178**） | `npm run verify` |
| C10 | `npm run verify` exit 0 | — |

**C1 的诚实性约束**：本机**没有 `ANTHROPIC_API_KEY`**，无法发真实请求。
因此基准脚本必须：
- 无 key 时用**受控假 provider**（可配置分块数与块间隔），输出标注 `[模拟]`
- 有 key 时打真实 API，输出标注 `[真实]`
- REPORT 里必须写明本次记录的是哪一种

不允许把模拟值当作真实测量报告。

## 五、风险预判

| 风险 | 影响 | 缓解 |
|---|---|---|
| 改用 `messages.stream()` 后响应解析路径变化，可能悄悄改变 `toolUses` 收集行为 | v0.3 刚修的并行工具调用回退 | `finalMessage()` 返回的仍是完整 `Anthropic.Message`，继续走 `parseAnthropicResponse`；v0.3 的 14 条 model-provider 用例作为回归网 |
| EventBus 替换 `onEvent` 是破坏性签名变更 | `index.ts` + `tests/agent-loop.test.ts` 的 harness | 保留 `onEvent` 作为「注册单个订阅者」的糖，签名不变；内部转为总线 |
| 订阅者抛异常若不隔离，会中断整个 Loop | 一个坏的埋点搞挂对话 | EventBus 内 try/catch 每个订阅者，异常降级为 stderr 警告 |
| 延迟基准用墙钟，天生有波动 | 数字不稳定 | 基准脚本**不是测试**，不进 `npm test`；多轮取中位数并输出全部样本 |
