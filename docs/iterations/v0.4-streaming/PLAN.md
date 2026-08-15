# v0.4 流式输出 · 实现计划

**Goal:** 把「等全量」变成「等首块」，并把事件分发收敛成 EventBus 为 v0.6 SSE 铺路。

**Architecture:** `ModelProvider` 内部一律 `messages.stream()`，通过可选 `opts.onDelta` 把文本块回调出来；`AgentLoop` 把它转成 `delta` 事件发到 `EventBus`；`EventBus` 支持多订阅者且异常隔离，`trajectory` 从构造依赖降级为普通订阅者。

**Tech Stack:** 不新增运行时依赖（`@anthropic-ai/sdk` 自带 `.stream()`）

**Spec:** `docs/iterations/v0.4-streaming/SPEC.md`

## Global Constraints

- 用例基线 **178**，不得净减
- `npm run verify` 必须 exit 0
- 既有 `onEvent` 签名保持可用（`index.ts` 与测试 harness 是消费者）
- 基准脚本不进 `npm test`（墙钟波动不该让测试变红）
- 每 Task 结束即提交，前缀 `feat(v0.4):` / `fix(v0.4):`

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `src/core/event-bus.ts` | 多订阅者事件总线，异常隔离 | 新建 |
| `src/core/types.ts` | `AgentEvent` 增 `delta`；`ChatProvider.chat` 增 `opts` | 修改 |
| `src/core/model-provider.ts` | 改用 `messages.stream()`，透传 `onDelta` | 修改 |
| `src/core/agent-loop.ts` | 用 EventBus 分发；传 `onDelta`；trajectory 变订阅者 | 修改 |
| `src/core/token-tracker.ts` | 修回退方向 + 窗口校验 + UTC 契约注释 | 修改 |
| `src/index.ts` | 逐块渲染；订阅方式改为总线 | 修改 |
| `scripts/bench-streaming.ts` | 首块 vs 全量延迟基准 | 新建 |
| `tests/event-bus.test.ts` | 订阅/退订/异常隔离/顺序 | 新建 |
| `tests/agent-loop.test.ts` | delta 顺序与拼接一致性 | 修改 |
| `tests/token-tracker.test.ts` | 回退方向 + 窗口校验 | 修改 |
| `package.json` | `bench:stream` 脚本 | 修改 |

---

## Task 1: EventBus

**Produces:**
```ts
export type EventSubscriber = (event: AgentEvent) => void;
export class EventBus {
  subscribe(fn: EventSubscriber): () => void;   // 返回 unsubscribe
  emit(event: AgentEvent): void;                // 订阅者异常被捕获，不外溢
  get subscriberCount(): number;
}
```

- [ ] Step 1: 写 `tests/event-bus.test.ts` —— 多订阅者按注册序收到、unsubscribe 生效、
      一个订阅者 throw 不影响其他订阅者也不外溢、emit 顺序稳定
- [ ] Step 2: 跑测试确认红（模块不存在）
- [ ] Step 3: 实现（每个订阅者 try/catch，异常走 `console.error` 降级）
- [ ] Step 4: 绿
- [ ] Step 5: 提交 `feat(v0.4): 新增 EventBus（多订阅者 + 异常隔离）`

---

## Task 2: delta 事件与流式 provider

**Produces:**
```ts
// types.ts
| { type: 'delta'; text: string }
export interface ChatOptions { onDelta?(text: string): void }
export interface ChatProvider {
  chat(systemPrompt: string, messages: Message[], tools: AgentTool[], opts?: ChatOptions): Promise<ChatResponse>;
  getModel(): string;
}
```

- [ ] Step 1: 在 `tests/agent-loop.test.ts` 加用例 —— 假 provider 按块回调 `onDelta`，
      断言：`delta` 事件均出现在 `response` 之前；所有 delta 拼接 === response 内容
- [ ] Step 2: 跑测试确认红
- [ ] Step 3: 实现
  - `ModelProvider.chat` 改为 `this.client.messages.stream({...})`，
    监听 `.on('text', (t) => opts?.onDelta?.(t))`，再 `await stream.finalMessage()`
    交给既有 `parseAnthropicResponse`（保住 v0.3 的并行工具调用行为）
  - `AgentLoop` 调用时传 `onDelta: (text) => this.emit({ type: 'delta', text })`
- [ ] Step 4: 绿（含 v0.3 的 178 条不许碰红）
- [ ] Step 5: 提交 `feat(v0.4): 模型调用改为流式并新增 delta 事件`

---

## Task 3: AgentLoop 接入 EventBus + CLI 逐块渲染

- [ ] Step 1: `AgentLoop` 内部持有 `EventBus`；`onEvent` 入参转为 `bus.subscribe(onEvent)`；
      `trajectory` 入参转为 `bus.subscribe(e => trajectory.log(e))` —— 两者签名不变，消费者无感
- [ ] Step 2: 暴露 `getEventBus()` 供 v0.6 的 SSE 适配器订阅
- [ ] Step 3: `index.ts` 的 `delta` 分支用 `process.stdout.write(text)` 逐块输出；
      `response` 分支改为只补一个换行（内容已经流式打出来了）
- [ ] Step 4: 全量测试 + tsc
- [ ] Step 5: 提交 `refactor(v0.4): AgentLoop 事件分发收敛到 EventBus，CLI 逐块渲染`

---

## Task 4: 承接 v0.3 评审的三项

**4a. `resolvePricing` 回退方向**

现状：注释说「调用发生在更早」，代码却 `return hit ?? windows[windows.length - 1]`（最未来的窗口）——方向相反。

改为按时间轴两端分别回退，并让回退**可被识别**：

```ts
export type PricingResolution = PriceWindow & { resolved: 'exact' | 'before-first' | 'after-last' | 'unknown-model' };
```
`CostRecord` 增 `pricingResolved` 字段，对账时能筛出所有非 `exact` 的记录。

**4b. 窗口校验** —— 模块加载时断言每个型号的窗口「按时间有序、无重叠、无缝隙」，
违反直接 throw（计费表录错必须是吵的，不能静默取第一个匹配）。

**4c. UTC 契约** —— `PriceWindow` 注释写明「边界按 UTC 日期判定」。

- [ ] Step 1: 写测试（早于所有窗口 → `before-first`；晚于 → `after-last`；未知型号 → `unknown-model`；构造重叠窗口 → 校验函数 throw）
- [ ] Step 2: 红 → 实现 → 绿
- [ ] Step 3: 提交 `fix(v0.4): 价格窗口回退方向修正 + 一致性校验 + UTC 契约`

---

## Task 5: 延迟基准

`scripts/bench-streaming.ts`：

```
用法: npm run bench:stream
无 ANTHROPIC_API_KEY → [模拟] 受控假 provider（默认 40 块 × 20ms）
有 ANTHROPIC_API_KEY → [真实] 打一次 Anthropic API
```

输出：首块延迟 / 全量延迟 / 倍数，多轮取中位数并列出全部样本。

- [ ] Step 1: 实现脚本 + `package.json` 加 `"bench:stream": "tsx scripts/bench-streaming.ts"`
- [ ] Step 2: 跑并记录真实输出
- [ ] Step 3: 提交 `feat(v0.4): 首块 vs 全量延迟基准脚本`

---

## Task 6: 验收与留档

- [ ] Step 1: 逐条核 C1–C10
- [ ] Step 2: 红-绿验证 —— 摘掉 `onDelta` 透传，确认 delta 顺序用例变红，恢复
- [ ] Step 3: `REPORT.md` + ROADMAP 进度
- [ ] Step 4: 提交 + `git tag -a v0.4` + 推送

## Self-Review

**Spec 覆盖**：10 项 → Task 1(1) / Task 2(3,4,5) / Task 3(2,6) / Task 4(8,9,10) / Task 5(7)。无遗漏。
**占位符**：Task 1/2/4 的测试给了断言目标，实现时以目标为准。其余含可执行代码或命令。
**类型一致性**：`ChatOptions` 在 Task 2 定义、Task 3 使用；`EventBus` 在 Task 1 定义、Task 3 使用；
`PricingResolution` 仅在 Task 4 内部。已核对。
