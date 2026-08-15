# v0.6 服务化 · 实测报告

> 完工 2026-08-15 ｜ Tag `v0.6` ｜ 起点 `8be0de3`(v0.5)
> **项目不再依赖终端输入 —— 外部系统可以接入了。**

---

## 一、验收判据（E1–E12）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| E1 | SSE 事件序列以 `session` 开头、`done` 结尾 | ✅ | `content-type` 含 `text/event-stream`；首事件 `session`，末事件 `done` |
| E2 | delta 在 response 之前，拼接 === response | ✅ | `lastIndexOf('delta') < indexOf('response')`，拼接串相等 |
| E3 | 不传 sessionId → 新建 | ✅ | 首事件带 session_id，且 `GET /v1/sessions/:id` 返回 200 |
| E4 | 传已存在 sessionId → 续接上下文 | ✅ | 第二轮后历史里同时有「第一轮问题」「第二轮问题」 |
| E5 | 不存在的 sessionId → **404 且不新建** | ✅ | 404 + `session_not_found`，`provider.calls === 0` |
| E6 | `/v1/chat/sync` 返回完整 JSON | ✅ | `reply` / `session_id` / `usage` 齐全 |
| E7 | 缺 `message` → 400，错误体含字段名 | ✅ | `error.code === 'invalid_request'`，message 含 `message` |
| E8 | 注入输入 → `blocked` 事件且不调模型 | ✅ | `blocked.by === 'input-filter'`，`provider.calls === 0`，**仍发 done** |
| E9 | 会话查询接口 + 404 | ✅ | 元信息、消息历史（含工具配对信息）、两个 404 |
| E10 | `/healthz` 可用 200 / 不可用 503 | ✅ | 注入一个 query 抛错的 db → 503 `storage_unavailable` |
| E11 | 用例数不净减（基线 223） | ✅ | **245 passed / 24 files** |
| E12 | `npm run verify` exit 0 | ✅ | 全绿 |

| | v0.5 | v0.6 | 变化 |
|---|---|---|---|
| 用例数 | 223 | **245** | +22 |
| 测试文件 | 22 | 24 | +2 |
| src 文件 / 行 | 36 / 3002 | 39 / 3402 | +3 / +400 |

---

## 二、本版最重要的收获：一个 flaky 测试抓出了 v0.5 的真 bug

全量测试出现**间歇失败（3 次挂 1 次）**。没有重试掩盖，而是查到底：

```
FAIL  listByUser 按创建时间倒序
- Expected: [ "session-1786782806251-kxuxg3", "session-1786782806251-vw7ioy" ]
+ Received: [ "session-1786782806251-vw7ioy", "session-1786782806251-kxuxg3" ]
                          ^^^^^^^^^^^^^ 同一毫秒
```

**根因**：`sessions` 按 `created_at DESC, id DESC` 排序。PostgreSQL 的 `now()` 返回
**事务开始时间**，同一毫秒创建的两个会话 `created_at` 完全相同 → 退化到 `id DESC`，
而 id 的后缀是**随机字符串**，与创建顺序无关 → 顺序随机。

**讽刺之处**：v0.5 刚刚为 `session_entries` 用 `BIGSERIAL` 解决过一模一样的问题
（REPORT 里还专门写了「不用 created_at 排序，因为并发下时间戳会相同」），
却在 `sessions` 表上漏了同一个坑。**同一类错误在同一个版本里犯了两次，第二次没被发现。**

**修法**（迁移只追加不改已发布的，这是我自己定的规矩）：

```sql
-- 002_sessions_seq
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS seq BIGSERIAL;
DROP INDEX IF EXISTS idx_sessions_user;
CREATE INDEX IF NOT EXISTS idx_sessions_user_seq ON sessions (user_id, seq DESC);
```

**验证**：
- 修复前后各连跑 5 次：修复前 3/5 挂，修复后 **5/5 全绿**
- 新增回归用例「同一毫秒创建 8 个会话仍按创建顺序倒序」
- 红-绿：把排序改回 `created_at DESC, id DESC` → 该用例**确定性变红**（不是随机变红）

**教训**：flaky 测试的默认处理不该是「重试」或「加 sleep」。它是并发/顺序类缺陷的
**唯一自动信号** —— 这次它替我抓到了一个已经打了 tag 推上去的真 bug。

---

## 三、核心设计

### ⚙️ 设计① AgentEvent → SSE，1:1 直通

v0.4 收敛 EventBus 的回报在这里兑现 —— **SSE 写出器只是又一个订阅者**：

```ts
bus.subscribe((event) => writer.writeEvent(event));
```

`AgentLoop` 一行没改。事件名与内部事件一一对应（`delta` / `thinking` / `tool_start` /
`tool_end` / `response` / `blocked` / `error` / `done`），调用方不需要额外映射表。

**终端事件保证**：v0.4 让 `blocked` 路径也 emit `done`，SSE 契约据此成立 ——
客户端「收到 done 就关流」，不靠超时。E8 专门断言了被拦截时仍有 `done`。

### ⚙️ 设计② 每请求装配，进程无会话状态

```ts
const session = body.session_id
  ? await Session.restore(stores.sessions, body.session_id)  // null → 404
  : await Session.create(stores.sessions, {...});
```

进程内不缓存任何会话。代价是每请求读一次库（v0.7 用 Redis 优化），
收益是**任意实例都能接任意请求**。`stores` 在进程启动时开一次、请求间共享——
不是每请求开库。

**404 而不是静默新建**：这是刻意的。静默新建会让「会话丢失」表现为
「模型突然失忆」，是最难排查的一类故障。E5 断言此时 `provider.calls === 0`。

### ⚙️ 设计③ CLI 降级为瘦客户端

`src/index.ts` 现在**没有一行 Agent 逻辑** —— 它 `fetch` SSE 流并渲染。
这不是形式主义：如果 CLI 还能直接调 `AgentLoop`，说明服务化只是加了层壳。

```
npm run serve   # 起服务
npm start       # 客户端（连不上时给明确指引，不是连接错误堆栈）
```

---

## 四、计划外发现：Fastify 默认会静默吞掉未知字段

`additionalProperties: false` 写了，但请求带多余字段仍返回 200。

**原因**：Fastify 的 ajv 默认 `removeAdditional: true` —— 未知字段被**静默剥掉**而非报错。

**为什么必须改**：调用方把 `session_id` 写成 `sessionId` 时，字段被悄悄丢弃 →
每轮都新建会话 → 他只会看到「模型不记事」，而请求返回 200、日志里什么都没有。
这类拼写错误必须在边界上就报 400。

```ts
Fastify({ ajv: { customOptions: { removeAdditional: false } } })
```

---

## 五、偏离 SPEC 之处

**无。** 本版 12 项 ✅ 清单全部落地，❌ 清单一项未碰。

唯一的额外改动是修 v0.5 遗留的排序 bug —— 按 ROADMAP 第四节的准入线判断：
① 本版改动亲自触发？**是**（本版新增的服务端测试并行跑，才让同毫秒创建高频发生）；
② 不补会在本版内继续误导验收？**是**（`npm run verify` 随机变红，无法作为验收依据）。
两条都满足，属于允许的当版补洞。

---

## 六、遗留问题

| 问题 | 归属 |
|---|---|
| 鉴权（API key / JWT） | v1.0 |
| 限流 | v0.11（与配额共用 Redis 计数器） |
| 客户端断连后 Loop 仍跑完（本版只停写出，不中断） | v1.0 韧性版 |
| 服务端高风险工具一律拒绝（无异步确认通道） | v0.12 业务流状态机 |
| Redis 会话热缓存 | v0.7 |
| PGlite 与真实 PG 未做对照验证 | 待环境具备 |
| OpenAPI 文档生成 | v0.14 |

---

## 七、提交清单

```
<本次> feat(v0.6): HTTP + SSE 服务化，CLI 降级为瘦客户端
```

Tag：`v0.6`
