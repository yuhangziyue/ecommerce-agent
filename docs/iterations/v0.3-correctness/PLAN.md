# v0.3 核心链路正确性 · 实现计划

**Goal:** 修掉 4 个正确性缺陷，其中两个 🔴 会直接导致对话中断（并行工具调用丢块、restore 出的历史非法）。

**Architecture:** 并行工具调用采用「内部模型保持简单，合并发生在传输层」——`Message` 支持 `toolUses[]`，工具结果仍是 N 条独立 tool 消息，由 `messagesToAnthropicFormat` 合并成单条 user 消息。`Session.getMessages()` 从「过滤 message 类型」改为「投影完整 entry 流」，让 restore 与运行时天然一致。

**Tech Stack:** TypeScript 5.6 · TypeBox · ajv · vitest 2.1（不新增依赖）

**Spec:** `docs/iterations/v0.3-correctness/SPEC.md`

## Global Constraints

- 不新增运行时依赖；不碰流式、不碰 HTTP、不碰 PG（见 SPEC「不做」）
- 用例总数不得净减少（基线 **142**）
- `./node_modules/.bin/tsc --noEmit` 必须 exit 0 且无输出
- `MODEL_PRICING` 只允许**新增**条目：`token-tracker.test.ts` 硬编码了 `claude-sonnet-4-20250514` 的 3/15 价格，删除即碰红
- 每 Task 结束即提交，前缀 `fix(v0.3):` / `feat(v0.3):` / `refactor(v0.3):`
- 验收铁律：任何「通过」结论必须附当轮实跑命令与输出

---

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `src/core/types.ts` | `ChatResponse.toolUses: ToolUse[]`；`Message.toolUses?: ToolUse[]` | 修改 |
| `src/core/model-provider.ts` | 收集全部 `tool_use` 块；合并连续 tool 消息为单条 user 消息 | 修改 |
| `src/core/agent-loop.ts` | 遍历多工具：低风险并发、高风险串行确认；结果保序回喂 | 修改 |
| `src/core/session.ts` | `getMessages()` 改为投影完整 entry 流 | 修改 |
| `src/core/token-tracker.ts` | `MODEL_PRICING` 补 Claude 5 系列（保留旧条目） | 修改 |
| `src/tools/refund-store.ts` | `RefundStore` 接口 + 进程内实现，按 orderId 幂等 | 新建 |
| `src/tools/refund-apply.ts` | 接入 `RefundStore`，重复申请返回原工单 | 修改 |
| `src/index.ts` | 默认模型改 `claude-opus-5` | 修改 |
| `tests/model-provider.test.ts` | 更新 `toolUse`→`toolUses`；新增合并形态用例 | 修改 |
| `tests/context-manager.test.ts` | 更新 `toolUse`→`toolUses` | 修改 |
| `tests/agent-loop.test.ts` | 更新 `toolReply` 助手；新增并行/并发/混合用例 | 修改 |
| `tests/session.test.ts` | 新增投影与 restore 往返用例 | 修改 |
| `tests/refund-apply.test.ts` | 幂等用例（此前无该文件） | 新建 |
| `tests/token-tracker.test.ts` | 新增 Claude 5 价格用例 | 修改 |

---

## Task 1: 类型改复数 + 传输层合并

**Files:** Modify `src/core/types.ts` `src/core/model-provider.ts` `tests/model-provider.test.ts` `tests/context-manager.test.ts`

**Interfaces:**
```ts
export interface ChatResponse { content: string; toolUses: ToolUse[]; usage: TokenUsage; stopReason: string }
export interface Message { role: Role; content: string; toolUses?: ToolUse[]; toolResult?: {...}; timestamp: number }
```

- [ ] **Step 1: 写失败测试**（追加到 `tests/model-provider.test.ts`）

```ts
it('多个 tool_use 块全部被收集（不再后者覆盖前者）', () => {
  // 由 parseAnthropicResponse 断言，见 Step 3 导出
  const parsed = parseAnthropicResponse({
    content: [
      { type: 'text', text: '我来查两样' },
      { type: 'tool_use', id: 'tu_1', name: 'order_lookup', input: {} },
      { type: 'tool_use', id: 'tu_2', name: 'product_search', input: {} },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
    stop_reason: 'tool_use',
  } as never);
  expect(parsed.toolUses.map(t => t.id)).toEqual(['tu_1', 'tu_2']);
});

it('连续的 tool 消息合并成一条 user 消息（拆开会训练模型停止并行调用）', () => {
  const out = messagesToAnthropicFormat([
    { role: 'user', content: 'q', timestamp: 1 },
    { role: 'assistant', content: '', toolUses: [
        { id: 'tu_1', name: 'a', input: {} },
        { id: 'tu_2', name: 'b', input: {} }], timestamp: 2 },
    { role: 'tool', content: 'r1', toolResult: { toolUseId: 'tu_1', result: { content: 'r1' } }, timestamp: 3 },
    { role: 'tool', content: 'r2', toolResult: { toolUseId: 'tu_2', result: { content: 'r2' } }, timestamp: 4 },
  ]);
  expect(out).toHaveLength(3);                       // user / assistant / user(合并)
  expect((out[1].content as unknown[])).toHaveLength(3); // text + 2×tool_use
  const merged = out[2].content as Array<{ type: string; tool_use_id: string }>;
  expect(merged).toHaveLength(2);
  expect(merged.map(b => b.tool_use_id)).toEqual(['tu_1', 'tu_2']);
});
```

- [ ] **Step 2: 跑测试确认失败** — `npx vitest run tests/model-provider.test.ts`
- [ ] **Step 3: 实现**
  - `types.ts`：`toolUse` → `toolUses`（两处）
  - `model-provider.ts`：新增导出 `parseAnthropicResponse(raw): ChatResponse`（把响应块解析独立出来便于测试），收集 `toolUses: ToolUse[]`
  - `messagesToAnthropicFormat`：改为带「待合并 tool_result 缓冲区」的遍历——遇到 tool 消息就入缓冲，遇到非 tool 消息或结束就 flush 成一条 user 消息
- [ ] **Step 4: 全量改名连带更新** — `tests/context-manager.test.ts` 的 `toolUseMsg` 助手、`tests/agent-loop.test.ts` 的 `toolReply` 助手
- [ ] **Step 5: 跑测试确认通过 + tsc**
- [ ] **Step 6: 提交** — `fix(v0.3): 支持并行工具调用的响应解析与传输层合并`

---

## Task 2: AgentLoop 多工具执行

**Files:** Modify `src/core/agent-loop.ts` · `tests/agent-loop.test.ts`

**Interfaces:** 无对外签名变化；`run()` 行为扩展为遍历 `response.toolUses`

执行策略：
1. 先对全部 toolUses 做「查找 + 校验」，不合法的直接生成错误结果（不进入执行阶段）
2. 再**串行**处理需要确认的高风险工具（同时弹多个确认框，用户不知道在批准什么）
3. 剩余低风险/已确认工具用 `Promise.all` **并发**执行
4. 按 toolUses 原始顺序回填结果，逐条 push 成 tool 消息

- [ ] **Step 1: 写失败测试**

```ts
it('一次响应含 3 个 tool_use 时全部执行，结果按原顺序回喂', async () => { /* 断言 3 个 execute 被调用 + 顺序 */ });
it('低风险工具并发执行（3×50ms 总耗时 < 120ms）', async () => { /* Date.now() 计时 */ });
it('高风险工具串行逐个确认', async () => { /* onConfirm 调用次数 === 高风险工具数 */ });
it('高风险被拒时其余工具仍执行，且每个 tool_use 都有配对结果', async () => {});
it('每个 tool_use 都产生一条 tool 消息（配对不变量）', async () => { /* 从 session 投影断言 */ });
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现** —— 把原来单 `toolUse` 分支重构为 `executeToolUses(toolUses)` 私有方法
- [ ] **Step 4: 跑测试确认通过（含 v0.2 的 21 条不许碰红）**
- [ ] **Step 5: 提交** — `fix(v0.3): AgentLoop 支持并行工具调用（低风险并发/高风险串行确认）`

---

## Task 3: Session 投影 + restore 往返

**Files:** Modify `src/core/session.ts` · `tests/session.test.ts`

**Interfaces:** `getMessages(): Message[]` 语义从「过滤」改为「投影」

投影规则：`message` → 原样；`tool_result` → 合成 `role:'tool'` 消息；`tool_call` / `metadata` → 跳过

- [ ] **Step 1: 写失败测试**

```ts
it('getMessages 投影 tool_result 为 tool 消息（此前整段丢失）', () => {
  const s = Session.create();
  s.appendMessage({ role: 'user', content: 'q', timestamp: 1 });
  s.appendMessage({ role: 'assistant', content: '', toolUses: [{ id: 'tu_1', name: 't', input: {} }], timestamp: 2 });
  s.appendToolCall({ toolUseId: 'tu_1', toolName: 't', input: {} });
  s.appendToolResult({ toolUseId: 'tu_1', result: { content: 'r1' }, durationMs: 5 });

  const msgs = s.getMessages();
  expect(msgs.map(m => m.role)).toEqual(['user', 'assistant', 'tool']);
  expect(msgs[2].toolResult!.toolUseId).toBe('tu_1');
});

it('restore 后的历史每个 tool_use 都有配对 tool_result（API 合法性不变量）', () => { /* 往返 */ });

it('restore 出的历史喂给 messagesToAnthropicFormat 不产生孤立 tool_result', () => {
  // 断言首条不是携带 tool_result 的 user 消息
});
```

- [ ] **Step 2/3/4:** 红 → 实现投影 → 绿（原 9 条 session 用例不许碰红）
- [ ] **Step 5: 提交** — `fix(v0.3): Session.getMessages 改为投影完整事件流，修复 restore 历史残缺`

---

## Task 4: 退款幂等

**Files:** Create `src/tools/refund-store.ts` `tests/refund-apply.test.ts` · Modify `src/tools/refund-apply.ts`

**Interfaces:**
```ts
export interface RefundTicket { refundId: string; orderId: string; amount: number; reason: string; createdAt: number }
export interface RefundStore {
  findByOrderId(orderId: string): RefundTicket | undefined;
  create(t: Omit<RefundTicket, 'refundId' | 'createdAt'>): RefundTicket;
}
export class InMemoryRefundStore implements RefundStore {}
export function getDefaultRefundStore(): RefundStore;   // 进程内单例
export function __resetRefundStore(): void;             // 测试隔离
```

- [ ] **Step 1: 写失败测试** `tests/refund-apply.test.ts`

```ts
it('同一订单重复申请返回同一工单号，不新建', async () => {
  const first = await refundApplyTool.execute({ orderId: 'ORD-20260801-002', reason: '不想要了' });
  const second = await refundApplyTool.execute({ orderId: 'ORD-20260801-002', reason: '换个理由' });
  const id1 = (first.metadata as { refundId: string }).refundId;
  const id2 = (second.metadata as { refundId: string }).refundId;
  expect(id2).toBe(id1);
  expect(second.content).toContain('已提交过');
});
it('不同订单各自独立建单', async () => {});
it('未付款订单仍然拒绝', async () => {});
it('已退款订单仍然拦截', async () => {});
```

（注：用例里的订单号需先确认其 `status` 不是 `pending`/`refunded`，实现时以 `src/data/orders.json` 实际数据为准）

- [ ] **Step 2/3/4:** 红 → 实现 → 绿
- [ ] **Step 5: 提交** — `fix(v0.3): 退款按订单号幂等，重复申请返回原工单`

---

## Task 5: 模型与价格表升级

**Files:** Modify `src/core/token-tracker.ts` `src/index.ts` · `tests/token-tracker.test.ts`

新增价格（USD / 1M tokens，来自 claude-api 技能的当前模型表）：

| 模型 | input | output |
|---|---|---|
| `claude-opus-5` | 5 | 25 |
| `claude-opus-4-8` | 5 | 25 |
| `claude-sonnet-5` | 3 | 15 |
| `claude-haiku-4-5` | 1 | 5 |
| `claude-fable-5` | 10 | 50 |

- [ ] **Step 1: 写失败测试** —— `claude-opus-5` 1M input + 1M output 成本应为 30（5 + 25）
- [ ] **Step 2/3/4:** 红 → 补表 + 默认模型改 `claude-opus-5` → 绿（旧模型 3/15 用例不许碰红）
- [ ] **Step 5: 提交** — `fix(v0.3): 默认模型升级 claude-opus-5 并补 Claude 5 系列价格表`

---

## Task 6: 全量验收与留档

- [ ] **Step 1: 逐条核 SPEC 第四节 B1–B11**（附真实命令输出）
- [ ] **Step 2: 红-绿验证** —— 把 `messagesToAnthropicFormat` 的合并逻辑改回「每条 tool 消息各发一条 user 消息」，确认合并用例变红，再恢复
- [ ] **Step 3: 写 `REPORT.md`**，更新 `docs/ROADMAP.md` 进度表
- [ ] **Step 4: 提交 + tag + 推送**

```bash
git tag -a v0.3 -m "v0.3 核心链路正确性：并行工具调用 + Session 事件溯源一致性"
git push origin master --follow-tags
```

---

## Self-Review

**1. Spec 覆盖**：SPEC 第三节 9 项 → Task 1(项1,2,3) / Task 2(项4) / Task 3(项5,6) / Task 4(项7) / Task 5(项8) / 各 Task 的 Step(项9)。无遗漏。

**2. 占位符扫描**：Task 2 的 5 个用例、Task 3 的 2 个用例给了断言目标而非完整代码（完整约 180 行，写进计划降低可读性）；实现时以断言目标为准，不接受降级。Task 4 的订单号需按真实数据校准，已在计划中标注。其余步骤含可直接执行的代码或命令。

**3. 类型一致性**：`toolUses` 在 Task 1 定义，Task 2（AgentLoop 遍历）、Task 3（session 投影断言）使用一致；`parseAnthropicResponse` 在 Task 1 Step 3 定义并在 Step 1 测试中使用；`RefundStore` 在 Task 4 定义且只在该 Task 内使用。已核对无漂移。
