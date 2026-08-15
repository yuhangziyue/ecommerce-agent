# v0.7 · 多轮记忆（Memory）

> 起点 `19ff659`（v0.6）｜ 后继 v0.8 多轮意图识别
> v0.6 让服务能对外提供，v0.7 让它**记得住**。

---

## 一、迭代目的

当前 Agent 的"记忆"只有一层：把最近 N 条消息塞回 prompt。这带来三个用户可感知的缺陷：

1. **长会话失忆** —— 超过窗口的内容直接丢弃。客户在第 3 轮说了订单号，第 15 轮问"那个订单到了吗"，
   Agent 已经不知道"那个"是什么了。
2. **跨会话零记忆** —— 同一个客户今天问过、明天再来，一切从头开始。收货偏好、称呼、
   历史投诉全部不存在。
3. **每请求读全量历史** —— v0.6 每个 HTTP 请求都从 PG 读整个会话。会话越长越慢，
   而且读的是"全部"，哪怕只需要最近几轮。

同时清掉两个 v0.5/v0.6 记账的欠账（都在这一版激活）：
- **缓存 token 完全没计价** —— `costUsd` 只算 input+output，cache read/write 成本恒为 0
- **`getTotalTokens()` 漏算缓存 token** —— 而预算熔断靠它，大缓存前缀的会话永远不触发熔断

## 二、核心设计

### ⚙️ 设计① 三层记忆，各司其职

```
┌─ 短期：滑窗 ────────────── 最近 N 条原文，逐字保真
│   已有 ContextManager.trimSafely（配对感知）
│
├─ 中期：摘要压缩 ────────── 被滑窗挤出去的内容压成一条摘要，不丢事实
│   触发：消息数超阈值 → 取最老的一段 → 让模型压成摘要 → 替换成一条 system 消息
│   关键：摘要本身进 session（可审计、可 restore），不是临时对象
│
└─ 长期：用户画像 ────────── 跨会话持久化，按 userId 存 PG
    称呼/联系方式偏好/收货习惯/历史关注点；每轮开头注入 system 上下文
```

**为什么中期不能省**：只有短期+长期时，滑窗一丢就是硬丢失。
真实客服对话里"刚才说的那个订单"极常见，而它往往正好在窗口边缘。

**摘要必须落 session**：如果只在内存里压缩，restore 出来的会话就没有摘要，
第二个请求会重新压缩一次（多花一次模型调用，且两次摘要可能不一致）。

### ⚙️ 设计② 缓存是可选加速，不是依赖

本机 Redis 需要认证且密码未知 —— 这反而定下了正确的设计：
**Redis 不可用时服务照常工作，只是变慢。**

```
SessionCache
   ├─ RedisSessionCache   REDIS_URL 可用时
   └─ NoOpSessionCache    缺省 / 连接失败 → 全部 miss，直接打库
```

任何缓存异常都降级为 miss + 一条告警日志，**绝不让缓存故障变成服务故障**。

### ⚙️ 设计③ 缓存 token 进计价与预算

```ts
PriceWindow {
  input, output,
  cacheRead?:  number,  // 默认 0.1 × input
  cacheWrite?: number,  // 默认 1.25 × input（5 分钟 TTL）
}
```

`getTotalTokens()` 改为含缓存 token —— API 的 `input_tokens` 语义是
**未命中缓存的剩余部分**，真实 prompt 规模 = `input + cache_creation + cache_read`。
不含缓存的预算熔断，对大缓存前缀会话等于没有。

同时区分两个语义，不让一个名字承担两件事：
- `getPromptTokens()` —— 真实 prompt 规模（含缓存），预算熔断用
- `getBilledTokens()` —— 计费口径

## 三、边界

### ✅ 本版做

| # | 事项 | 类型 |
|---|---|---|
| 1 | `SummaryCompactor`：超阈值时把最老一段压成摘要，落 session | 设计① |
| 2 | 摘要消息参与 `getMessages()` 投影，restore 后仍在 | 设计① |
| 3 | `UserProfileStore`（PG）：按 userId 存画像，跨会话可读 | 设计① |
| 4 | 画像作为 system 上下文注入每轮（中间件形式，不改 Loop） | 设计① |
| 5 | `SessionCache` 接口 + `RedisSessionCache` + `NoOpSessionCache` | 设计② |
| 6 | 缓存失效：会话有写入即失效该 key | 设计② |
| 7 | Redis 不可用时自动降级为 NoOp（不抛错、不阻塞启动） | 设计② |
| 8 | `PriceWindow` 增 `cacheRead` / `cacheWrite` 系数并计入 `costUsd` | 🔧 |
| 9 | `getPromptTokens()`（含缓存，预算用）/ `getBilledTokens()` 拆分 | 🔧 |
| 10 | 摘掉 `model-provider` 读缓存字段的两处 `as any`（SDK 是 `number \| null`） | 🔧 |
| 11 | `GET /v1/users/:id/profile` 查画像 | 🛒 |

### ❌ 本版不做

| 事项 | 留给 | 理由 |
|---|---|---|
| 向量检索 / 语义记忆 | 不做 | 电商客服的记忆是结构化的（订单号、偏好），向量检索是过度设计 |
| 自动从对话抽取画像字段 | v0.13 | 需要结构化返回协议；本版画像由工具显式写入 |
| prompt caching 真正开启（`cache_control`） | v0.14 | 需先用 `count_tokens` 量前缀是否够门槛（512~4096），且要有评测基线才能判断收益 |
| 意图识别 / 多 Agent | v0.8 / v0.9 | — |
| Redis 限流 | v0.11 | 与配额同主题 |

> **注意第 3 项**：本版把缓存 token **计价与预算**修好，但**不开启** prompt caching。
> 修的是"开了之后账不会错"，不是"现在就开"。这两件事分开做，才能在 v0.14 有评测基线时
> 干净地评估缓存收益。

## 四、验收标准

| # | 判据 | 验证方式 |
|---|---|---|
| F1 | 消息超阈值时触发压缩，摘要落进 session 且 restore 后仍在 | `tests/memory/compactor.test.ts` |
| F2 | 压缩后消息数下降，且**最近若干轮原文保留**（不压最近的） | 同上 |
| F3 | 压缩只发生一次（第二次请求不重复压缩同一段） | 同上 |
| F4 | 画像跨会话可读：会话 A 写入，会话 B 读到 | `tests/memory/profile-store.test.ts` |
| F5 | 画像作为 system 上下文进入模型调用 | `tests/memory/profile-middleware.test.ts` |
| F6 | Redis 可用时命中缓存（第二次读不打库） | `tests/store/session-cache.test.ts` |
| F7 | 会话写入后缓存失效（不会读到过期历史） | 同上 |
| F8 | **Redis 不可用时服务照常工作**（降级为 NoOp，不抛错） | 同上 |
| F9 | 缓存 token 计入成本：cache read 按 0.1×、write 按 1.25× | `tests/token-tracker.test.ts` |
| F10 | `getPromptTokens()` 含缓存 token，预算熔断据此触发 | 同上 + `tests/middleware.test.ts` |
| F11 | `model-provider` 无 `as any` 读缓存字段，且 `null` 被正确归一 | `tests/model-provider.test.ts` |
| F12 | 用例数不净减（基线 **245**） | `npm run verify` |
| F13 | `npm run verify` exit 0 | — |

## 五、风险预判

| 风险 | 影响 | 缓解 |
|---|---|---|
| 压缩要调模型，可能失败或超时 | 本轮对话挂掉 | 压缩失败**降级为不压缩**（只记警告），绝不因为压缩失败而拒绝服务 |
| 摘要丢失关键事实（订单号等） | 用户体验倒退 | 压缩 prompt 明确要求保留标识类信息；用例断言订单号出现在摘要里 |
| Redis 缓存与库不一致 | 读到过期历史 | 写入即失效该 key；缓存只存"整段 entries"，不做增量合并 |
| 本机 Redis 需认证 | 无法验证真实 Redis 路径 | 测试起独立实例（端口 6380，无认证），并显式测 NoOp 降级路径 |
| `getTotalTokens` 语义变更影响既有预算用例 | 既有测试碰红 | 保留 `getTotalTokens()` 为 `getBilledTokens()` 的别名，新语义走新方法名 |
