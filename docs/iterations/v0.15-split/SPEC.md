# v0.15 · 微服务拆分

> 起点 `5d43a01`（v0.14）｜ 后继 v1.0 生产化收口
> **这一版验证前十四版的边界是不是真的。**

---

## 一、迭代目的

### 边界是假的，拆的时候才会原形毕露

ROADMAP 从第一版就写着「先在单进程验证边界，稳定后再拆」。现在到了兑现的时候。

一查就发现了两处**假边界**：

```ts
// ① AgentLoop 依赖的是具体类，不是接口
private readonly registry: ToolRegistry;
this.registry.get(name) / .validate(name, input) / .getAll()
tool.execute(input, ctx)                    // ← 直接拿到函数对象调用

// ② 工具依赖模块级单例
let currentStore: RefundStore = new InMemoryRefundStore();   // refund-store.ts
let engine: FlowEngine | null = null;                        // return-request.ts
```

`tool.execute` 是**函数引用**，它跨不了进程。只要 Loop 拿到的是「一个能执行的对象」，
工具就永远只能和它在同一个进程里 —— 这不是性能问题，是**架构上的死结**。

> 单进程里「模块之间调得通」不等于「边界是清晰的」。
> 判据只有一个：**把中间换成网络，还能不能跑。**
> 换不了，说明之前所谓的分层只是文件夹的分法。

### 拆之后才能回答的问题

| 问题 | 现状 |
|---|---|
| 工具执行能不能独立扩容？ | 不能，和编排绑死在一个进程 |
| 一个慢工具会不会拖垮整个服务？ | 会，同进程同事件循环 |
| 工具能不能用别的语言写？ | 不能 |
| 跨进程的一次请求怎么追？ | 没有 trace 传播 |

## 二、核心设计

### ⚙️ 设计① 把 `ToolRegistry` 换成 `ToolGateway` 接口

Loop 不再持有「能执行的工具对象」，只持有一个**网关**：

```ts
interface ToolGateway {
  list(): Promise<ToolDescriptor[]>;          // 名称/描述/schema/riskLevel
  validate(name, input): ValidationResult;
  execute(name, input, ctx): Promise<ToolResult>;
}
```

两个实现：
- `LocalToolGateway` —— 包住现有 `ToolRegistry`，**单进程行为一字不变**
- `RemoteToolGateway` —— HTTP 调用工具服务

关键点：`riskLevel` 必须**随描述符过来**。它决定要不要走 v0.12 的确认流，
而那是编排层的决策 —— 如果只有工具服务知道风险等级，编排层就没法拦。

### ⚙️ 设计② 工具服务：单一职责的独立进程

```
┌──────────────────┐        ┌──────────────────┐
│  agent-service   │        │   tool-service   │
│  编排/记忆/意图   │  HTTP  │   工具执行        │
│  路由/安全/计费   │───────▶│   业务数据        │
│  确认/流程        │        │   退款/流程 store │
└──────────────────┘        └──────────────────┘
        │                            │
        └────── 同一个 PostgreSQL ────┘
```

模块级单例（退款 store、流程引擎）**跟着工具走** —— 它们本来就属于工具执行层。
这个拆分让那两个全局变量从「架构污点」变成「服务内部实现细节」。

### ⚙️ 设计③ 跨进程 trace

一次对话产生的所有动作要能串起来：

```
X-Trace-Id: tr_xxx     入口生成，随每次工具调用透传
X-Span-Id:  sp_xxx     每次工具调用一个
```

不引入 OTel SDK（延续 v0.14 的判断），只做**最小可用的 trace 传播**：
入口生成 traceId → 放进 `ToolContext` → 网关塞进 HTTP 头 → 工具服务打日志时带上。

## 三、边界

### ✅ 本版做

| # | 事项 | 类型 |
|---|---|---|
| 1 | `ToolGateway` 接口 + `ToolDescriptor` | 设计① |
| 2 | `LocalToolGateway`：包 `ToolRegistry`，行为不变 | 设计① |
| 3 | `AgentLoop` 改用 `ToolGateway` | 设计① |
| 4 | `tool-service`：独立 Fastify 应用 | 设计② |
| 5 | `RemoteToolGateway`：HTTP 客户端 | 设计② |
| 6 | 工具服务的错误语义（超时/不可达/5xx） | 设计② |
| 7 | traceId / spanId 生成与透传 | 设计③ |
| 8 | 工具服务的 `/metrics` 与 `/healthz` | 设计③ |
| 9 | **同一套用例跑两种网关**，证明行为一致 | 验收 |

### ❌ 本版不做

| 事项 | 留给 | 理由 |
|---|---|---|
| 服务注册发现 / 网格 | 不做 | 两个服务，配置 URL 即可；引入注册中心是过度设计 |
| 熔断 / 重试 / 降级 | **v1.0** | 那是韧性版的主题，本版只保证错误语义正确 |
| 会话服务、记忆服务再拆 | 不做 | 它们与编排强耦合，拆了只是增加网络跳数 |
| OTel 全量 trace | 不做 | 只做 traceId 透传，够排查即可 |
| 容器化 / 编排文件 | v1.0 | 部署归生产化版 |

## 四、验收标准

| # | 判据 | 验证方式 |
|---|---|---|
| S1 | `AgentLoop` 不再引用 `ToolRegistry` 具体类 | 类型层面 |
| S2 | **同一套用例在 Local 与 Remote 网关下结果一致** | 参数化测试 |
| S3 | 单进程模式行为一字不变（既有 589 用例全绿） | `npm run verify` |
| S4 | 工具服务能独立启动并执行工具 | 端到端 |
| S5 | `riskLevel` 随描述符跨进程传递，确认流仍生效 | 远程模式下退款仍要确认 |
| S6 | 工具服务不可达 → 明确报错，**不谎称工具执行失败** | 错误语义 |
| S7 | 工具服务超时 → 明确报错并计入指标 | — |
| S8 | traceId 全链路透传 | 工具服务收到同一个 traceId |
| S9 | 参数校验在**两侧都做**（不信任调用方） | 远程直接打非法参数被拒 |
| S10 | 用例数不净减（基线 **589**） | `npm run verify` |
| S11 | `npm run eval` 三维门仍通过 | 拆分不该让质量/成本/延迟退化 |
| S12 | `npm run verify` exit 0 | — |

## 五、风险预判

| 风险 | 影响 | 缓解 |
|---|---|---|
| 改 `AgentLoop` 的工具路径，回归面最大 | 破坏 589 条用例 | `LocalToolGateway` 保证单进程语义一字不变；先本地全绿再做远程 |
| 远程错误被当成「工具执行失败」喂给模型 | 模型向客户胡说 | 错误语义分层：网络故障 ≠ 工具报错，措辞明确区分 |
| 参数只在一侧校验 | 工具服务被直接打 | **两侧都校验**；远程侧的用例直接打非法参数 |
| trace 只是摆设 | 排查时没用 | 用例断言工具服务真的收到了 traceId |
| 拆分让延迟明显上升 | 体验退化 | 用 `npm run eval` 的延迟维度守住；本地模式仍是默认 |
