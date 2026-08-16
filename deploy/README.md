# 部署

> ⚠️ **本目录的产物未经实际构建与运行验证** —— 开发机上没有 Docker。
> 拓扑、环境变量、依赖关系是按代码实际读取的变量写的，但请首次部署时自行核对。

## 拓扑

```
                    ┌──────────────┐
   客户端 ─────────▶│ agent-service│  编排/记忆/意图/路由/安全/计费/确认
                    └──────┬───────┘
                           │ HTTP（熔断 + 重试）
                    ┌──────▼───────┐
                    │ tool-service │  工具执行（可独立扩容）
                    └──────┬───────┘
                           │
              ┌────────────┴────────────┐
        ┌─────▼─────┐            ┌──────▼─────┐
        │ PostgreSQL│            │   Redis    │
        │ 会话/账本  │            │ 缓存/配额   │
        │ 流程/确认  │            │（可选）     │
        └───────────┘            └────────────┘
```

## 启动

```bash
export ANTHROPIC_API_KEY=sk-...
docker compose -f deploy/docker-compose.yml up --build
```

## 关键环境变量

| 变量 | 作用 | 缺省 |
|---|---|---|
| `ANTHROPIC_API_KEY` | 必需 | — |
| `DATABASE_URL` | 不设则用 PGlite（进程内 PG，零配置） | PGlite |
| `REDIS_URL` | 不设则无缓存、配额直接查库（慢但正确） | 无 |
| `TOOL_SERVICE_URL` | 不设则工具在本进程执行（行为一致） | 本进程 |
| `AGENT_SAFETY_LAG` | 流式脱敏滞后窗口；`0` 关闭（会漏跨块检测） | 40 |
| `SHUTDOWN_GRACE_MS` | 优雅退出等待在途请求的上限 | 15000 |
| `TOOL_TIMEOUT_MS` | 远程工具调用超时 | 10000 |

## 两种运行形态

**单进程**（不设 `TOOL_SERVICE_URL`）：一个服务跑全部，适合中小流量与本地开发。
**拆分**（设了）：工具执行独立扩容，慢工具不拖垮编排层。

两种形态的**行为完全一致** —— v0.15 用同一套用例跑两种网关验证过。

## 灰度与回滚

- 服务无状态（状态全在 PG/Redis），滚动更新即可
- 收到 SIGTERM 后 `/healthz` 立刻转 503，编排系统据此停止派新流量，
  而进程继续服务在途请求至多 `SHUTDOWN_GRACE_MS`
- `stop_grace_period` 必须 **大于** `SHUTDOWN_GRACE_MS`，否则在途请求会被砍断


## v1.1 · 上线前必须做的两件事

### 1. 签发凭证（认证默认开启，不签发就没人能调）

```bash
docker compose exec agent-service npm run key:issue -- \
  --tenant t_acme --scopes chat,read --label '官网客服'
```

明文**只出现这一次** —— 库里存的是 sha256 哈希，我们自己也拿不回来。
客户丢了只能重新签发，这是正确的行为不是缺陷。

```bash
docker compose exec agent-service npm run key:issue -- --list   --tenant t_acme
docker compose exec agent-service npm run key:issue -- --revoke key_xxxx
```

### 2. 设置 `TOOL_SERVICE_TOKEN`

拆分形态下工具服务是**第二个入口**，而 `POST /v1/tools/execute` 能直接执行退款 ——
主服务上的高危确认流（v0.12）挡在编排层，绕过去就不存在了。
不设这个变量时服务会启动并**在日志里警告**，但端口是开放的。

### 环境变量总表（v1.1 新增）

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENT_AUTH_DISABLED` | 未设 | 设 `1` 关闭认证。**只用于本地开发**，启动会打警告 |
| `AGENT_RATE_LIMIT_RPS` | `20` | 每凭证每秒请求数，设 `0` 关闭 |
| `TOOL_SERVICE_TOKEN` | 未设 | 工具服务共享密钥。两侧都要设且一致 |

限流有 `REDIS_URL` 时全局准确；没有则降级为**进程内令牌桶**——
多实例下配额是 N 倍。当前档位在 `/healthz` 的 `rate_limit` 字段里看得到。

## v1.2 · 追踪与清理的环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENT_OTLP_ENDPOINT` | 未设 | OTLP/HTTP collector 地址（如 `http://otel-collector:4318/v1/traces`）。**不设也有追踪** —— 走内存缓冲，`GET /v1/traces/:id` 可查 |
| `AGENT_TRACE_BUFFER` | `2000` | 内存环形缓冲的 span 上限 |
| `AGENT_TURN_LOCK_TTL_MS` | `60000` | 会话独占锁的 TTL。正常路径在请求结束时立刻释放，TTL 只是进程崩溃的兜底 |
| `AGENT_SWEEP_INTERVAL_MS` | `600000` | 过期幂等记录的清理周期。设 `0` 关闭 |

> ⚠️ `GET /v1/traces/:id` 读的是**本实例**的内存缓冲。多实例部署下只能看到打到那台机器的部分 ——
> 要全局查询就接 collector（OTLP 已经通了）。这个接口的定位是「没有 collector 时也能看链路」，
> 不是替代 collector。
