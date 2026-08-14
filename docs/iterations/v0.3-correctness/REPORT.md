# v0.3 核心链路正确性 · 实测报告

> 完工 2026-08-15 ｜ Tag `v0.3` ｜ 起点 `ce8dca4`(v0.2)
> 每条结论附当轮实跑命令与真实输出。

---

## 一、验收判据逐条核对（SPEC 第四节 B1–B11）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| B1 | 3 个 `tool_use` 全部执行 | ✅ | `agent-loop.test.ts` → `一次响应含 3 个 tool_use 时全部执行，结果按原顺序回喂`：`executed.sort() === ['t1','t2','t3']`，且 tool 消息顺序 `['result_t1','result_t2','result_t3']` |
| B2 | 多个 `tool_result` 合并成**一条** user 消息 | ✅ | `model-provider.test.ts` → 断言 `out` 长度 3（user/assistant/合并 user），合并块 `tool_use_id === ['tu_1','tu_2']` |
| B3 | 低风险工具并发执行 | ✅（判据已改进，见第三节） | `低风险工具并发执行：第二个在第一个完成前就已启动（串行则死锁）` |
| B4 | 高风险串行逐个确认 | ✅ | `confirmOrder === ['risky_1','risky_2']` —— 只问高风险且按序，`safe_1` 未被询问 |
| B5 | 高风险被拒时其余工具仍执行，每个 tool_use 都有配对结果 | ✅ | `riskyExecuted === false`、`safeExecuted === ['safe_1','safe_2']`、tool 消息数 3 === toolUses 数 3 |
| B6 | restore 后 `getMessages()` 含 tool 消息且可配对 | ✅ | `session.test.ts` → `useIds === ['tu_1','tu_2']`，`resultIds.sort() === useIds.sort()` |
| B7 | restore 出的历史不产生孤立 tool_result | ✅ | `wire[0] === { role:'user', content:'查订单和商品' }`；tool_result 组数 1，组内 2 块 |
| B8 | 同一订单重复退款返回同一工单号 | ✅ | `refund-apply.test.ts` 8 条用例，含**三次并发同订单只产生一个工单** |
| B9 | `claude-opus-5` 按 $5/$25；旧模型不变 | ✅ | 1M+1M → `$30`；`claude-sonnet-4-20250514` 仍 `$18` |
| B10 | 全部测试通过，用例数不净减（基线 142） | ✅ | **178 passed / 18 files** |
| B11 | `tsc --noEmit` exit 0 | ✅ | `npm run verify` 全绿（src + tests 双配置） |

```
$ npm run verify
> tsc --noEmit && tsc -p tsconfig.test.json && vitest run

 Test Files  18 passed (18)
      Tests  178 passed (178)
   Duration  556ms
```

| | v0.2 `ce8dca4` | v0.3 | 变化 |
|---|---|---|---|
| 测试文件 | 17 | 18 | +1 |
| 用例数 | 142 | **178** | **+36** |
| src 文件 / 行 | 28 / 2082 | 29 / 2344 | +1 / +262 |
| tests 行 | 1906 | 2597 | +691 |

---

## 二、红-绿验证

本版最核心的修复是「多个 tool_result 合并进同一条 user 消息」。撤销它，用例必须变红：

```bash
# 把合并改回「每条结果各发一条 user 消息」
$ perl -0pi -e "s/result.push\(\{ role: 'user', content: pendingToolResults \}\);/pendingToolResults.forEach((b) => result.push({ role: 'user', content: [b] }));/" src/core/model-provider.ts

$ npx vitest run tests/model-provider.test.ts -t '合并'
 × v0.3 关键：连续的 tool 消息合并成一条 user 消息
   → expected [ Array(4) ] to have a length of 3 but got 4
 Tests  1 failed | 1 passed | 12 skipped (14)

# 恢复
$ npx vitest run tests/model-provider.test.ts
 Tests  14 passed (14)
```

---

## 三、修掉的缺陷（4 项）

### 🔴 1. 并行工具调用丢块

`model-provider.ts` 原为 `let toolUse: ToolUse | undefined`，多个 `tool_use` 块后者覆盖前者。

修法分三层：
- **解析层**：抽出 `parseAnthropicResponse()`，`toolUses.push(...)` 收集全部块（并导出便于单测）
- **类型层**：`ChatResponse.toolUses: ToolUse[]`（必填数组，不用可选字段——避免调用方漏判 `undefined`）、`Message.toolUses?: ToolUse[]`
- **传输层**：`messagesToAnthropicFormat` 用「待合并缓冲区」把**连续的** tool 消息合并进一条 user 消息

`AgentLoop.executeToolUses()` 四阶段：全量规划（查找+校验）→ 高风险串行确认 → 其余并发执行 → 按原序回喂。

**不变量**：每个 `tool_use` 恰好产生一条 tool 结果消息，包括工具不存在、参数不合法、用户拒绝这三种失败路径。这是 API 合法性的底线。

### 🔴 2. `Session.restore()` 历史残缺

`getMessages()` 从**过滤**（`entries.filter(e => e.type === 'message')`）改为**投影**（走完整 entry 流）：

| entry 类型 | 投影结果 |
|---|---|
| `message` | 原样 |
| `tool_result` | 合成 `role:'tool'` 消息 ← **此前整段丢失的部分** |
| `tool_call` | 跳过（信息已在 assistant.toolUses 里，重复投影会双计） |
| `metadata` | 跳过（非对话内容） |

好处：不需要在 `appendToolResult` 之外重复写一条 `message` entry，JSONL 里不存两遍同样的数据。

### 🟡 3. 退款非幂等

新增 `src/tools/refund-store.ts`：`RefundStore` 接口 + `InMemoryRefundStore`，按 `orderId` 去重。
`createIfAbsent()` 是同步的检查-写入，中间无 `await` 切点，因此在单线程 JS 里天然原子——
`三次并发申请同一订单只产生一个工单` 这条用例验证了这一点。

重复申请**不覆盖原始退款原因**（审计口径以首次为准），`metadata.status` 区分 `submitted` / `already_submitted`。

⚠️ **本版不宣称「生产级幂等」**：store 是进程内的，重启即失效。接口已定，v0.5 换 PG `UNIQUE(order_id)` 实现。

### 🟡 4. 模型与价格表过期 —— 改为带生效日期区间

默认模型 `claude-sonnet-4-20250514`（2026-06-15 退役）→ `claude-opus-5`。

价格表**没有**简单地补几个键值，而是改成 `Record<string, PriceWindow[]>`：

```ts
'claude-sonnet-5': [
  { until: '2026-08-31', input: 2, output: 10 },  // 引入期定价
  { from:  '2026-09-01', input: 3, output: 15 },  // 标准定价
]
```

原因见第四节 —— 这是本版**采纳外部评审意见后改变的设计**。
`add(usage, model, at = Date.now())` 按**调用发生的时刻**解析价格，补算历史会话成本时传入原始时间就能拿到当时的价格。

---

## 四、采纳的外部评审意见（苏姐巡检，2026-08-15 00:20）

本版中途插入了一次产品总监视角的独立巡检，四条被采纳：

| 意见 | 原计划 | 实际做法 | 为什么改 |
|---|---|---|---|
| **`claude-sonnet-5` 引入期定价 16 天后到期，写死任一数字都会错** | 价格表补 `sonnet-5: {3, 15}` | 改为带 `from`/`until` 的价格窗口数组 | 写 $2/$10 则 9-1 起全线偏低，写 $3/$15 则这 16 天偏高。而 SPEC 自己写了「v0.11 计费账本以此表为基础」——基础漂了上层全漂 |
| **B3 是墙钟断言，天生 flaky** | `3×50ms 工具总耗时 < 120ms` | 改为 deferred promise：`tool_b` 启动后才放行 `tool_a`，**串行则死锁** | 墙钟断言在 CI 抖动/并发跑测时随机变红。v0.14 要建三维回归门，一条 flaky 用例的成本会被放大 |
| **`tests/docs/iterations/v0.2-wire-up/` 空目录残留** | — | 已 `rm -rf`（是 v0.2 期间 cwd 误落 `tests/` 造成的） | git 不跟踪空目录，v0.2 的 A11 判据对它是盲的 |
| **ROADMAP 与 REPORT 缺陷计数不一致（5 vs 6）** | — | 回填 ROADMAP v0.2 行 | 总纲失真会在第 10 版之后变成对不上账 |

未采纳的一条：她指出 v0.3 缺 `PLAN.md` —— 巡检时点在我写完 SPEC、正在写 PLAN 之间，属时点差，PLAN 已存在。

---

## 五、计划外发现（2 项，均已处理）

### 1. Task 顺序需要调换

`PLAN.md` 把「AgentLoop 多工具执行」排在 Task 2、「Session 投影」排在 Task 3。
实际 Task 2 的 3 条用例都要断言 `session.getMessages()` 里的 tool 消息，
而那正是 Task 3 才修的投影。实跑时 Task 2 有 3 条红灯，落 Task 3 后自动转绿。

**教训**：写计划时按「设计的逻辑顺序」排 Task，但验证依赖可能是反向的。
下一版排 Task 前先问一句「这一步的断言依赖哪一步的实现」。

### 2. 🔴 测试代码根本没过类型检查（本版顺手补上）

改名 `toolUse` → `toolUses` 时，`tests/context-manager.test.ts:207` 漏了一处 `m.toolUse`。
`tsc --noEmit` **一声不响** —— 因为根 `tsconfig.json` 的 `include` 只有 `src/**/*`。

只有跑测试才炸，而且炸出来的是「不变量断言失败」这种看起来像业务 bug 的现象。
接下来还有 12 个版本的重构，这个洞每次改名都会咬一口。

处理：新增 `tsconfig.test.json`（`extends` 根配置 + `types: ["node","vitest/globals"]` + 放开
`rootDir`/`declaration`，因为只检查不产出），并加 npm script：

```json
"typecheck": "tsc --noEmit && tsc -p tsconfig.test.json",
"verify": "npm run typecheck && npm test"
```

实测**测试代码本身零类型错误**（补上 globals 声明后 `error TS` 计数为 0），所以这是纯收益、没有清理债务。
以后验收统一跑 `npm run verify`。

> 这属于 SPEC 边界之外的增补。判断依据：它不是新功能，是**修补一个刚刚造成真实故障的验证缺口**，
> 且成本是一个配置文件。若留到 v0.14 再做，中间 11 个版本的重构都在无网走钢丝。

---

## 六、遗留问题

| 问题 | 归属 | 说明 |
|---|---|---|
| 退款幂等仅进程内，重启失效 | **v0.5** | 换 PG `UNIQUE(order_id)` |
| `ContextManager.trimMessages`（旧盲切版）应删除 | **v0.5** | 生产路径已全走 `trimSafely`，但它仍是公开 API 且有 6 条测试 |
| 流式输出 / adaptive thinking / effort 参数 | **v0.4** | 本版刻意未动 |
| prompt caching 是否值得开，需先 `count_tokens` 量前缀长度 | **v0.7** | 门槛按模型 512~4096 tokens |
| `ResponseScorer` 启发式打分不可信 | **v0.14** | — |
| 安全规则仅 5 条正则，无分级无审计 | **v0.10** | — |
| 价格表需随 Anthropic 调价维护；`claude-sonnet-5` 的 9-1 切换已编码，其余型号若有限时定价需补窗口 | 持续 | 已有 `PriceWindow` 结构承接，不需要再改设计 |

---

## 七、提交清单

```
7adef5d fix(v0.3): 并行工具调用 + Session 事件流投影（两个 🔴 修复）
<本次>  fix(v0.3): 退款幂等 + 带生效期的价格表 + 测试类型检查补洞
```

Tag：`v0.3`
