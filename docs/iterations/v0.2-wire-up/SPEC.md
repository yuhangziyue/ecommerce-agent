# v0.2 · 接线与地基（Wire-up & Foundation）

> 迭代规格。开工前写，作为 `PLAN.md` 的论据来源与 `REPORT.md` 的验收基准。
> 起点：`2b5e61a`（README）｜ 前置依赖：无 ｜ 后继：v0.3 核心链路正确性

---

## 一、迭代目的（为什么现在做这个）

**因为整个项目当前处于「测试全绿但能力没通电」的状态，不先解决它，后面 13 个版本全是建在沙子上。**

实测证据（`2b5e61a`）：

```bash
$ grep -rn --include='*.ts' -E "from '\./(tools|guardrails|memory|evaluation)/" src/ \
    | grep -v '^src/\(tools\|guardrails\|memory\|evaluation\)/'
# 输出为空 —— guardrails / memory / evaluation / tool-registry 运行时零引用
```

具体后果：

1. **安全能力不存在**：`InputFilter`（5 条注入正则）、`OutputFilter`（手机号/身份证/API key 脱敏）写好了但没接，线上等于裸奔。
2. **成本能力不存在**：`ContextManager` 没接 → 消息数组只增不减，input token 随轮次二次增长，只能等 `maxTokensPerSession` 硬熔断。
3. **测的不是跑的**：`index.ts` 内联 4 个工具在跑（零测试），`src/tools/*.ts` 5 个有测试（零流量）。79 个用例的绿灯**没有覆盖任何一行真实执行路径**。
4. **核心不可测**：`AgentLoop` 在构造函数里 `new ModelProvider()`，无法注入假实现 → 循环编排、预算熔断、确认拒绝、工具报错回喂这四条关键路径一个测试都没有。

**排序理由**：v0.3 要修的 parallel tool use 和 Session.restore 是两个真 bug，但它们只在特定路径触发；而安全能力缺失是**任何一次请求都在裸奔**。且 v0.3 的修复需要 `AgentLoop` 可测才能验证 —— 依赖注入必须先做。所以接线在前。

## 二、核心设计（本版 2 项）

### ⚙️ 设计① Guardrail / 记忆 / 评测 → 中间件管道化

**不要**把 `if (inputFilter.check(...))` 硬塞进 `AgentLoop`。那样每加一个横切能力就要改一次 Loop，v0.10 安全增强、v0.11 计费检测会把 Loop 撑成泥球。

改为三个钩子点的中间件管道：

```
用户输入
   │
   ├─ [beforeTurn]   ──▶ 注入检测 · 内容合规（v0.10 扩展）· 会话级鉴权（v0.6 扩展）
   │                     可 block（短路整轮）/ rewrite（改写输入）
   ▼
AgentLoop while 循环
   │
   ├─ [beforeModel]  ──▶ 预算熔断 · 上下文裁剪 · 配额检测（v0.11 扩展）
   │                     每轮 LLM 调用前执行，可 block / 改写 messages
   ▼
最终回复
   │
   ├─ [afterTurn]    ──▶ PII 脱敏 · 回答打分 · 合规声明追加（v0.10 扩展）
   │                     可 rewrite（改写回复）/ block
   ▼
返回调用方
```

收益：v0.10 的安全增强、v0.11 的计费检测**只需新增中间件，不动 Loop 一行**。这是为后面 13 个版本留的扩展点。

### ⚙️ 设计② 工具单一来源 + ModelProvider 依赖注入

三件事一起做，因为它们是同一个「可测性」问题的三个面：

1. **删掉 `index.ts` 的内联工具定义**，统一走 `src/tools/*.ts` + `ToolRegistry`。让「被测的」和「在跑的」合并成一套。
2. **工具参数类型与 schema 单一来源**：TypeBox `Static<typeof Schema>` 推导 `execute` 的入参类型，消除「schema 写了 `phoneLast4` 而实现读 `phone`」这类漂移。
3. **`AgentLoop` 接受注入的 `ChatProvider`**（接口），默认用 `ModelProvider` 实现。测试可注入脚本化的假 provider，从而首次能测循环编排。

## 三、边界

### ✅ 本版做

| # | 事项 | 类型 |
|---|---|---|
| 1 | `Pipeline` + `AgentMiddleware` 接口与执行器 | 核心设计① |
| 2 | 4 个中间件：input-filter / output-filter / budget-guard / context-trim | 核心设计① |
| 3 | `ContextManager.trimSafely()`：配对感知裁剪（不切散 tool_use ↔ tool_result） | 缺陷修复 |
| 4 | `TrajectoryLogger` + `ResponseScorer` 接入（前者挂事件流，后者在 afterTurn 打分入 session metadata） | 核心设计① |
| 5 | `ChatProvider` 接口 + `AgentLoop` 依赖注入改造 | 核心设计② |
| 6 | 5 个工具统一为 TypeBox schema，注册进 `ToolRegistry`；删除 `index.ts` 内联定义 | 核心设计② |
| 7 | `human_handoff` 工具首次通电（此前从未被注册） | 🛒 业务场景 |
| 8 | 移植内联版的订单状态中文映射（否则删内联即功能回退） | 缺陷修复 |
| 9 | 修 `product-search`：`metadata.productIds` 取 `p.productId`（原 `p.id` 恒为 undefined） | 缺陷修复 |
| 10 | 修 `product-search`：`category` 参数 description 改为真实分类（原写「耳机、配件」，真实为「电子产品/服饰/食品」） | 缺陷修复 |
| 11 | 数据加载改为进程内缓存（原每次工具调用 `readFileSync` 重读磁盘） | 性能缺陷 |
| 12 | 更新 `system-prompt.ts` 至新工具名 + 补 `human_handoff` 使用规则 | 缺陷修复 |
| 13 | 新增 `blocked` AgentEvent，CLI 渲染被拦截的轮次 | 核心设计① |
| 14 | `sessions/` 加入 `.gitignore` 并停止跟踪（测试产物污染仓库） | 仓库卫生 |
| 15 | 补测试：`pipeline` / 4 个中间件 / `agent-loop`（⭐ 首次）/ `model-provider` / `data-loader` / `trimSafely` | 测试缺口 |

### ❌ 本版明确不做（留给后续版本）

| 事项 | 留给 | 理由 |
|---|---|---|
| 并行工具调用（`toolUses[]`） | v0.3 | 需要先有 `AgentLoop` 测试才能安全改循环 |
| `Session.restore()` 历史残缺修复 | v0.3 | 同上，且属于「正确性」主题 |
| 退款幂等（工单持久化 + 唯一约束） | v0.3 | 本版只移植现有状态检查，不改数据模型 |
| 默认模型升级 + 价格表更新 | v0.3 | 与退款幂等同属「正确性」批次 |
| 流式输出 | v0.4 | 需要改 `ModelProvider`，与本版 DI 改造冲突面大 |
| PostgreSQL / Redis | v0.5 | 本版不碰存储，`Session` 仍走 JSONL |
| HTTP 服务 | v0.6 | 本版仍是 CLI |
| 安全能力增强（语料集、分级、审计） | v0.10 | 本版只负责**接线**，把现有 5 条正则通电；不扩充规则 |
| 计费账本 | v0.11 | 本版只接现有 `BudgetGuard`，不做多租户账本 |

**边界原则**：本版一行新业务规则都不加，只做「把已有的接上 + 让核心可测」。任何「顺手再改一点」的冲动都推到对应版本。

## 四、验收标准（可执行判据）

| # | 判据 | 验证命令 |
|---|---|---|
| A1 | 运行时可达性检查输出**非空**，4 组模块全部被引用 | `grep -rn --include='*.ts' -E "from '\.\./(tools\|guardrails\|memory\|evaluation)/\|from '\./(tools\|guardrails\|memory\|evaluation)/" src/ \| grep -v '^src/\(tools\|guardrails\|memory\|evaluation\)/'` |
| A2 | `index.ts` 内不再有 `Type.Object` 内联工具定义 | `grep -c "Type.Object" src/index.ts` → 期望 `0` |
| A3 | 全部测试通过，且用例数 **≥ 79 + 新增**（不允许净减少） | `npm test` |
| A4 | 类型检查干净 | `./node_modules/.bin/tsc --noEmit`（exit 0，无输出） |
| A5 | 注入攻击被拦截：输入 `ignore all previous instructions` 时 Loop 不调用 LLM，返回拦截原因 | `tests/agent-loop.test.ts` 内断言 provider 调用次数为 0 |
| A6 | 回复中的手机号被脱敏：工具返回含 `13812345678` 时最终回复为 `138****5678` | `tests/agent-loop.test.ts` |
| A7 | 预算超限时不调用 LLM 并返回熔断提示 | `tests/agent-loop.test.ts` |
| A8 | 高风险工具确认被拒时，Loop 把「用户取消」作为 tool 结果回喂而非崩溃 | `tests/agent-loop.test.ts` |
| A9 | `trimSafely` 裁剪后首条消息必为 `user` 角色（不会出现孤立 tool_result） | `tests/context-manager.test.ts` 新增用例 |
| A10 | 数据文件只读一次：连续调用同一工具 3 次，`readFileSync` 仅触发 1 次 | `tests/data-loader.test.ts`（spy 计数） |
| A11 | `git status --short` 干净（sessions/ 不再冒出未跟踪文件） | `npm test && git status --short` |

## 五、风险预判

| 风险 | 影响 | 缓解 |
|---|---|---|
| 改 `order_lookup` 输出为中文状态会碰红既有断言 `toContain('shipped')` | 1 个用例 | **知情更新该断言**为中文，并在 `REPORT.md` 说明原因（断言应表达期望行为，而非固化不佳实现） |
| `AgentLoop` 构造签名改为对象入参，是破坏性变更 | 仅 `index.ts` 一个调用方 | 同版本内一起改；无外部消费者 |
| `ContextManager` 加新方法而非改旧方法 | 旧 `trimMessages` 保留但不再被生产代码调用 | 保留其测试（仍是公开 API），在 `REPORT.md` 标注「旧方法保留供对比，生产路径走 `trimSafely`」 |
| `git rm -r --cached sessions/` 会从版本库移除 19 个已提交文件 | 历史仍可查，工作区文件保留 | 先 `git rm --cached`（不删本地文件）再提交，`REPORT.md` 记录被移除的文件数 |
