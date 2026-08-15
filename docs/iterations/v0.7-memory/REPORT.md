# v0.7 多轮记忆 · 实测报告

> 完工 2026-08-15 ｜ Tag `v0.7` ｜ 起点 `19ff659`(v0.6)

---

## 一、验收判据（F1–F13）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| F1 | 超阈值触发压缩，摘要落 session 且 restore 后仍在 | ✅ | `摘要落 session，restore 后仍在` |
| F2 | 压缩后消息数下降，最近若干轮原文保留 | ✅ | `ctx.messages.length < before`；`keepRecent` 用例 |
| F3 | 压缩只发生一次（不重复压同一段） | ✅ | 两次调用 `provider.calls === 1` |
| F4 | 画像跨会话可读 | ✅ | 另一个 store 实例读到同样的 displayName / preferences |
| F5 | 画像进入 system 上下文 | ✅ | `ctx.systemAppends[0]` 含称呼，且 `userInput` 原样未被污染 |
| F6 | Redis 命中时不打库 | ✅ | 3 次读、内层只被调用 1 次 |
| F7 | 写入后缓存失效 | ✅ | 追加第二条后读到 2 条（不是缓存里的 1 条） |
| F8 | **Redis 不可用时服务照常** | ✅ | 连 6399（无人监听）→ 降级 NoOp；中途故障 → 全部降级为 miss，读写照常 |
| F9 | 缓存 token 计价 | ✅ | cache read 0.1×、write 1.25×；四种 token 累加 36.75 |
| F10 | `getPromptTokens` 含缓存，预算据此熔断 | ✅ | 旧口径 150 看似远未超，真实消耗 1250 已超 → `isOverBudget(1000) === true` |
| F11 | 无 `as any` 读缓存字段，`null` 正确归一 | ✅ | `grep "as any"` 只剩 TypeBox schema 解构那一处 |
| F12 | 用例数不净减（基线 245） | ✅ | **288 passed / 27 files** |
| F13 | `npm run verify` exit 0 | ✅ | 连跑 3 次全绿 |

| | v0.6 | v0.7 | 变化 |
|---|---|---|---|
| 用例数 | 245 | **288** | +43 |
| 测试文件 | 24 | 27 | +3 |

---

## 二、核心设计

### ⚙️ 设计① 三层记忆

| 层 | 实现 | 生命周期 |
|---|---|---|
| 短期 | `ContextManager.trimSafely`（v0.2 已有，配对感知） | 本轮 |
| **中期** | `SummaryCompactor` + `compaction` 中间件 | 本会话 |
| **长期** | `PgProfileStore` + `profile` 中间件 | 跨会话 |

**中期这层的三个关键决定：**

1. **摘要落 session**（新增 `summary` entry 类型），不是内存临时对象。
   只在内存压缩的话，`restore` 出的会话没有摘要，下个请求会重新压一次 ——
   多花一次模型调用，且两次摘要可能不一致。

2. **投影时摘要「吸收」它之前的 N 条消息**（`splice(0, n)` + `unshift`），不是追加。
   > 这是实现过程中当场发现并改掉的设计洞：最初写成追加，结果压缩后历史**更长了** ——
   > 中期记忆成了纯粹的负担。

3. **摘要用 `user` 角色而非 `system`**：`messagesToAnthropicFormat` 会跳过 system 消息
   （它们走顶层 system 参数），做成 system 摘要就永远到不了模型。

**长期这层**走 `ctx.systemAppends`（v0.7 新增的扩展点）而不是别的通道：
- 塞进 `userInput` → 画像被**写进会话历史**（污染记录，还会被下一轮再压缩一次）
- 塞进 `config.systemPrompt` → 影响**所有会话**（那是进程级配置）

`systemAppends` 是「只影响本轮、不污染历史」的注入通道，v0.8 意图槽位、v0.9 路由说明都会用它。

### ⚙️ 设计② 缓存是可选加速，不是依赖

本机 Redis 需要认证且密码未知 —— 这个约束反而定下了正确的设计。

```
createSessionCache(url)
  ├─ 无 URL           → NoOpSessionCache
  ├─ 连不上 / 超时     → 告警 + NoOpSessionCache（不抛错、不阻塞启动）
  └─ 连上             → RedisSessionCache
```

`RedisSessionCache` 的每个方法都 try/catch → **任何缓存异常降级为 miss**。
用例专门构造了「Redis 中途全线报错」的场景，验证读写照常。

**写入即失效，不做增量合并**：合并逻辑一旦有 bug 就是「读到过期历史」，
表现为模型行为诡异、极难定位。宁可多打一次库。

### ⚙️ 设计③ 缓存 token 计价与预算口径

一个名字不该承担两个语义，所以拆成三个：

| 方法 | 含义 | 用途 |
|---|---|---|
| `getTotalTokens()` | input + output | 保留原语义，向后兼容 |
| `getPromptTokens()` | input + cache_read + cache_write | 真实 prompt 规模 |
| `getConsumedTokens()` | prompt + output | **预算熔断口径** |

用例证明旧口径会漏判：`getTotalTokens() === 150` 看似远未超，
而真实消耗 1250 已超 —— 跑在大缓存前缀上的会话，用旧口径永远不会触发熔断。

> **注意**：本版修的是「开了 prompt caching 之后账不会错」，**不是现在就开**。
> 真正开启（`cache_control`）归 v0.14 —— 需要先用 `count_tokens` 量前缀是否够门槛
>（512~4096），且要有评测基线才能判断收益。

---

## 三、计划外发现与自我纠正

### 1. 摘要「追加」而非「吸收」—— 实现到一半发现的设计洞

写完中间件后立刻意识到：摘要只是 `appendSummary`，被压缩的消息**还在 entries 里**，
投影出来反而更长。改成 `splice(0, compactedCount)` + `unshift(摘要)`，让摘要真正顶替那一段。

**教训**：「压缩」这个词容易让人只想到「生成摘要」，忘了「替换原文」才是它一半的工作。

### 2. 用类型断言掏 Pipeline 私有字段 —— 写完就重构掉了

第一版把记忆中间件插进管道时，用 `(base as unknown as { middlewares: any[] })` 掏私有字段
来找 `context-trim` 的位置。`tsc` 能过，但这是脆弱写法：管道内部一改，这里静默错位。

改成 `buildDefaultPipeline({ preTurn, beforeTrim })` 显式扩展点 ——
**顺序约束留在拥有它的模块里**，调用方不需要知道管道内部结构。

### 3. 测试类型检查再次抓到漂移

`Stores` 加了两个字段、`TurnContext` 加了 `systemAppends`，六处测试构造点全部漏改。
`tsc -p tsconfig.test.json`（v0.3 补的洞）一次性列出全部，运行时一个都没提前暴露。

### 4. 一条会随迁移增长而失效的断言

`expect(executed).toEqual(['001_init', '002_sessions_seq'])` —— 加了 `003_user_profiles` 就红。
改为守**行为**（全部执行、按序、首条是 001）而非守清单。
**测试不该在每次正常演进时都要求修改**，否则它会变成负担而不是保护。

---

## 四、遗留问题

| 问题 | 归属 |
|---|---|
| prompt caching 真正开启（`cache_control`）+ 收益评估 | v0.14（需要评测基线） |
| 画像字段自动从对话抽取（当前只能由工具显式写入） | v0.13 |
| 摘要质量无评测（只验证了"订单号进了 transcript"，没验证摘要本身好不好） | v0.14 |
| Redis 限流 | v0.11 |
| PGlite 与真实 PG 未做对照验证 | 待环境具备 |
| 本机 6379 的 Redis 需认证，未验证真实生产 Redis 路径（测试用 6380 无认证实例） | 待环境具备 |

---

## 五、提交清单

```
6c481dc fix(v0.7): 缓存 token 计价与预算口径 + 摘掉 as any
6d47c2b feat(v0.7): 中期记忆 —— 摘要压缩
<本次>  feat(v0.7): 长期记忆（用户画像）+ Redis 会话缓存 + systemAppends 扩展点
```

Tag：`v0.7`
