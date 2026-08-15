# v0.9 多 Agent 路由 · 实测报告

> 完工 2026-08-15 ｜ Tag `v0.9` ｜ 起点 `ed53ddf`(v0.8)
> **进程内路由**，物理拆服务在 v0.15。

---

## 一、验收判据（H1–H12）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| H1 | 按意图解析到正确领域 | ✅ | product_search→presale、order_query/logistics→order、refund/after_sales→aftersale |
| H2 | 未知意图 → `general` 且工具是全集 | ✅ | `fallback().toolNames === []`（空=全集） |
| H3 | 每个意图都有归属 | ✅ | 遍历全部 9 类意图断言 `resolve` 有结果 |
| H4 | 领域提示词进 `systemAppends` | ✅ | — |
| H5 | `allowedTools` 设为该领域子集 | ✅ | 售前 `['product_search','faq_search']`，**不含 refund_apply** |
| H6 | Loop 只把子集内工具发给模型 | ✅ | 注册 3 个工具、白名单 2 个 → `lastToolCount === 2` |
| H7 | **子集外的工具仍可执行** | ✅ | 白名单只有 product_search，模型调 refund_apply → 照常执行 |
| H8 | 售前看不到 `refund_apply` | ✅ | SSE `routing` 事件断言 |
| H9 | SSE 出现 `routing` 事件 | ✅ | — |
| H10 | `GET /v1/agents` 返回领域列表 | ✅ | 兜底 Agent 工具面显示为 `*` |
| H11 | 用例数不净减（基线 321） | ✅ | **344 passed / 29 files** |
| H12 | `npm run verify` exit 0 | ✅ | — |

| | v0.8 | v0.9 | 变化 |
|---|---|---|---|
| 用例数 | 321 | **344** | +23 |
| 测试文件 | 28 | 29 | +1 |

**红-绿验证**：去掉 `AgentLoop` 里的工具过滤 → `只把子集内的工具发给模型` 确定性变红；恢复后 344 全绿。

---

## 二、核心设计

### ⚙️ 设计① 五个领域 Agent

| Agent | 意图 | 工具 |
|---|---|---|
| `presale` | product_search, chitchat | product_search, faq_search |
| `order` | order_query, logistics | order_lookup, faq_search |
| `aftersale` | after_sales, refund | order_lookup, **refund_apply**, faq_search, human_handoff |
| `account` | account | faq_search, human_handoff |
| `general` | unknown, complaint | **全部** |

拆分解决的是三个具体问题，不是为了架构好看：
1. **提示词互相稀释** —— 退款的严谨、售前的话术、投诉的安抚挤在一份 prompt 里，加得越多每条越不被遵守
2. **工具面过宽** —— 客户问「有什么好耳机」时 `refund_apply` 也在列表里，而选错高风险工具的代价不对称
3. **无法差异化配置** —— 售前可用便宜快的模型，退款必须用最强的（本版只搭骨架，换模型归 v0.14）

**`general` 拿全部工具是刻意的**：意图识别不出来时收窄工具面等于让 Agent 更无能。
兜底路径应该保持 v0.8 的能力，而不是比它更弱。

### ⚙️ 设计② 工具收窄是**引导**不是**鉴权**（本版最关键的一条）

`ctx.allowedTools` 只影响「发给模型的工具列表」，**不影响工具能否被执行**。
模型若仍调用了子集外的工具（比如历史消息里带着），照常执行。

理由：v0.8 明确写了意图识别可能出错。如果收窄同时变成鉴权，
**一次意图误判就会让合法请求失败** —— 用一个不确定的判断去做确定性的拦截，是错配。

H7 专门测了这条：白名单只有 `product_search`，模型调 `refund_apply` → 仍然执行成功。
真正的权限控制（谁能调退款）属于 v1.0 鉴权范畴。

### ⚙️ 设计③ 意图冲突在注册时就炸

```ts
if (existing && existing.id !== agent.id) {
  throw new Error(`[agents] 意图 "${intent}" 被 ${existing.id} 与 ${agent.id} 同时认领`);
}
```

一个意图被两个领域认领 = 路由不确定。这必须在**注册时**暴露，
而不是等到某次请求随机路由到其中一个 —— 后者表现为「同样的问题有时走这个 Agent 有时走那个」，
是最难复现的一类故障。

---

## 三、一致性护栏

除了行为测试，还加了三条**定义一致性**断言，防止后续版本加领域时踩坑：

| 断言 | 防的是什么 |
|---|---|
| 每个 Agent 的工具名都真实存在 | 手写工具名拼错 → 该工具永远不出现在任何领域里，且没有任何报错 |
| 每个提示词含「本轮领域」标题 | 领域提示词写成了通用规则，与全局 prompt 重复冲突 |
| 只有兜底 Agent 用空工具列表 | 误把普通领域写成空数组 → 意外获得全部工具（含高风险） |

第一条尤其重要：`toolNames` 是字符串，拼错不会有任何编译期或运行期错误，
只会表现为「这个领域少了个工具」。

---

## 四、遗留问题

| 问题 | 归属 |
|---|---|
| 物理拆分成独立服务 | **v0.15** |
| 每个领域配不同模型（售前用便宜的） | v0.14（需评测基线判断是否掉点） |
| Agent 间显式移交（handoff 协议） | v0.12 |
| 基于工具的权限控制 | v1.0（与鉴权一起） |
| 路由准确率评测 | v0.14 |
| 领域提示词与全局 prompt 的职责边界靠约定维持（无自动检查） | v0.14 |

---

## 五、提交清单

```
<本次> feat(v0.9): 多 Agent 路由（领域 Agent + 注册表 + 路由中间件 + 工具收窄）
```

Tag：`v0.9`
