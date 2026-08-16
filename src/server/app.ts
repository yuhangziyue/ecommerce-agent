import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { AgentLoop } from '../core/agent-loop.js';
import { ModelProvider } from '../core/model-provider.js';
import { EventBus } from '../core/event-bus.js';
import { Session } from '../core/session.js';
import { TokenTracker } from '../core/token-tracker.js';
import { buildDefaultPipeline, type SafetyAuditEntry } from '../middleware/index.js';
import { StreamingRedactor } from '../safety/streaming-redactor.js';
import {
  QuotaService,
  createQuotaCounter,
  type QuotaLimits,
} from '../billing/quota.js';
import { ANONYMOUS_TENANT } from '../store/pg-usage-store.js';
import { QUOTA_SCOPE_KEY } from '../middleware/quota.mw.js';
import { FlowEngine } from '../flows/engine.js';
import { buildReturnFlow, DEFAULT_RETURN_POLICY, RETURN_STATE_LABELS, type ReturnPolicy } from '../flows/return-flow.js';
import { ConfirmationService, summarizeToolCall } from '../flows/confirmation.js';
import { setFlowEngine } from '../tools/return-request.js';
import type { ConfirmationRecord } from '../flows/types.js';
import {
  CachedTenantConfig,
  resolveSafetyRules,
  resolveReturnPolicy,
  resolveQuotaLimits,
} from '../tenants/config.js';
import { INPUT_RULES, OUTPUT_RULES } from '../safety/rules.js';
import type { ToolArtifact } from '../artifacts/types.js';
import { MetricsRegistry } from '../observability/metrics.js';
import { LocalToolGateway, newTraceId, type ToolGateway } from '../tools/gateway.js';
import { buildMetrics, collectFrom, buildSafetyReport } from '../observability/collector.js';
import { readSafetyAudit } from '../middleware/safety.mw.js';
import { SafetyScanner } from '../safety/scanner.js';
import { DEFAULT_SAFETY_LAG } from '../safety/rules.js';
import { buildToolRegistry } from '../tools/index.js';
import { setRefundStore } from '../tools/refund-store.js';
import { SYSTEM_PROMPT } from '../prompts/system-prompt.js';
import { SseWriter } from './sse.js';
import { SummaryCompactor } from '../memory/summary-compactor.js';
import { createCompactionMiddleware } from '../middleware/compaction.mw.js';
import { createProfileMiddleware } from '../middleware/profile.mw.js';
import { createIntentMiddleware } from '../middleware/intent.mw.js';
import { IntentRecognizer } from '../intent/recognizer.js';
import { createRoutingMiddleware } from '../middleware/routing.mw.js';
import { AgentRegistry } from '../agents/registry.js';
import type { DomainAgent } from '../agents/types.js';
import type { IntentState } from '../intent/types.js';
import { Pipeline } from '../core/pipeline.js';
import {
  createAuthHook,
  canAccessTenant,
  notFound,
  principalOf,
  requireScope,
} from './auth.js';
import {
  createRateLimiter,
  NoOpRateLimiter,
  type RateLimiter,
  type RateLimitOptions,
} from './rate-limit.js';
import {
  readIdempotencyKey,
  withIdempotency,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  type IdempotentOutcome,
} from './idempotency.js';
import { requestFingerprint } from '../auth/api-key.js';
import { startSweeper } from './sweeper.js';
import {
  MemorySpanExporter,
  parseTraceparent,
  Tracer,
  type Span,
} from '../observability/tracing.js';
import type { Principal } from '../auth/types.js';
import type { Stores } from '../store/index.js';
import type { AgentConfig, AgentEvent, ChatProvider } from '../core/types.js';

export interface AppOptions {
  stores: Stores;
  config: AgentConfig;
  /** 注入假 provider 便于测试；缺省用真实 ModelProvider */
  provider?: ChatProvider;
  logger?: boolean;
  /**
   * v0.11 配额上限。缺省用 `config.maxTokensPerSession` 作会话上限、租户不限。
   * 传 0 表示该级不限。
   */
  quotaLimits?: QuotaLimits;
  /** v0.12 售后政策（时效与自动批准门槛）。业务参数，运营可调 */
  returnPolicy?: ReturnPolicy;
  /** v0.14 指标注册表。注入便于测试断言；缺省时内部新建 */
  metrics?: MetricsRegistry;
  /**
   * v0.15 工具网关。缺省用 `LocalToolGateway`（单进程，行为与 v0.14 完全一致）；
   * 传 `RemoteToolGateway` 则工具在独立的 tool-service 里执行。
   */
  toolGateway?: ToolGateway;
  /**
   * v1.1 认证。**默认开启** —— 关掉要显式传 `disabled: true`
   * （生产由 `AGENT_AUTH_DISABLED=1` 驱动，且启动时打警告）。
   * 延续 v1.0 `isRetryable` 缺省不重试的同一条原则：默认值站在出错时损失最小的一侧。
   */
  auth?: { disabled?: boolean };
  /** v1.1 限流。缺省按 `AGENT_RATE_LIMIT_RPS` 装配；传 `rateLimiter` 可注入假实现 */
  rateLimit?: RateLimitOptions & { redisUrl?: string; enabled?: boolean };
  rateLimiter?: RateLimiter;
  /** v1.1 幂等键有效期，缺省 24 小时 */
  idempotencyTtlMs?: number;
  /** v1.2 会话独占锁的 TTL。缺省 60s —— 够长到覆盖一次带工具的完整轮次 */
  turnLockTtlMs?: number;
  /** v1.2 追踪。不传则装一个只写内存环形缓冲的 Tracer（`/v1/traces` 可查） */
  tracer?: Tracer;
  /** v1.2 内存 span 缓冲。与 tracer 配套注入，供 `/v1/traces/:id` 查询 */
  spanBuffer?: MemorySpanExporter;
  /** v1.2 过期幂等记录的清理周期。0 表示不启动 sweeper */
  sweepIntervalMs?: number;
}

/**
 * 会话锁 TTL。
 *
 * 取值要够长到覆盖「多轮工具调用 + 模型响应」的最坏情况，
 * 又要够短到进程崩溃后会话不会长时间不可用。60s 是这两者的折中。
 */
export const DEFAULT_TURN_LOCK_TTL_MS = 60_000;

const CHAT_BODY_SCHEMA = {
  type: 'object',
  required: ['message'],
  properties: {
    message: { type: 'string', minLength: 1 },
    session_id: { type: 'string' },
    user_id: { type: 'string' },
    tenant_id: { type: 'string' },
  },
  additionalProperties: false,
} as const;

interface ChatBody {
  message: string;
  session_id?: string;
  user_id?: string;
  tenant_id?: string;
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { stores, config } = opts;
  const app = Fastify({
    logger: opts.logger ?? false,
    ajv: {
      customOptions: {
        // Fastify 默认 removeAdditional:true —— 未知字段被**静默剥掉**。
        // 那意味着调用方把 session_id 写成 sessionId 时，字段被悄悄丢弃、
        // 每轮都新建会话，而他只会看到「模型不记事」，永远查不到原因。
        // 这类拼写错误必须在边界上就报 400。
        removeAdditional: false,
      },
    },
  });

  // ============ v1.1 身份、限流、幂等 ============
  //
  // 三件事挂在最前面是刻意的：**未认证的请求不该走到请求体解析**，
  // 更不该消耗任何下游资源（v0.10 已经为「安全中间件必须最先」论证过同一件事）。
  app.addHook('onRequest', createAuthHook({ keys: stores.apiKeys, disabled: opts.auth?.disabled }));

  const rateLimiter =
    opts.rateLimiter ??
    (opts.rateLimit
      ? await createRateLimiter(opts.rateLimit)
      : new NoOpRateLimiter());

  app.addHook('onRequest', async (request, reply) => {
    // 没有 principal = 免认证路径（/metrics、/healthz）。
    // 探针被限流会让实例在高负载时被误判为不健康 —— 那正是雪崩的开始
    const principal = request.principal;
    if (!principal) return;

    // **按 principal 限而不是按 IP**：网关/LB 后面所有请求的 IP 都是同一个，
    // 按 IP 限流要么全放要么全封
    const verdict = await rateLimiter.consume(principal.keyId);
    if (!verdict.allowed) {
      return reply
        .status(429)
        .header('Retry-After', Math.ceil(verdict.retryAfterMs / 1000).toString())
        .send({
          error: {
            code: 'rate_limited',
            message: `请求过于频繁，请 ${Math.ceil(verdict.retryAfterMs / 1000)} 秒后重试`,
          },
        });
    }
  });

  app.addHook('onClose', async () => rateLimiter.close());

  // v1.2：过期幂等记录的清理。缺省 10 分钟一轮 ——
  // 放在请求路径上"顺手删几条"会把不确定的删除耗时加到每个请求上，
  // 而且删除量与流量成正比：流量高峰恰恰是最不该做清理的时候
  const sweeper = startSweeper({
    store: stores.idempotency,
    intervalMs: opts.sweepIntervalMs ?? 600_000,
  });
  app.decorate('sweeper', sweeper);
  app.addHook('onClose', async () => sweeper.stop());

  // v1.2 追踪。缺省装一个只写内存的 —— 没有 collector 的环境也能用 /v1/traces 看链路。
  // 生产接 OTLP 时由 server.ts 注入（见 AGENT_OTLP_ENDPOINT）
  const spanBuffer = opts.spanBuffer ?? new MemorySpanExporter();
  const tracer = opts.tracer ?? new Tracer({ exporter: spanBuffer });

  // 工具注册表与退款 store 是进程级的，装配一次。
  // v0.15：远程模式下这两样都不需要 —— 工具在 tool-service 里执行，
  // 那两个模块级单例也跟着搬过去了
  const toolGateway = opts.toolGateway ?? new LocalToolGateway(buildToolRegistry());
  if (!opts.toolGateway) setRefundStore(stores.refunds);

  const sharedProvider = opts.provider ?? new ModelProvider(config.model, config.apiKey);
  const compactor = new SummaryCompactor({ provider: sharedProvider, model: config.model });
  const recognizer = new IntentRecognizer({ provider: sharedProvider });
  const agents = new AgentRegistry();

  // v0.11：配额服务是进程级的，装配一次。
  // 计数器优先用 Redis（原子且快），连不上就直接查账本 —— 慢，但不停摆。
  const quotaLimits: QuotaLimits = opts.quotaLimits ?? {
    perSession: config.maxTokensPerSession,
    perTenant: 0, // 缺省不限租户；生产按合同配置
  };
  const quotaCounter = await createQuotaCounter(stores.usage, process.env.REDIS_URL);

  // v0.12：流程引擎与确认服务都是进程级的，装配一次。
  // 会话号不在这里绑定 —— 工具执行时从 ToolContext 拿，否则并发下会串会话。
  const basePolicy = opts.returnPolicy ?? DEFAULT_RETURN_POLICY;
  const flows = new FlowEngine(stores.flows, [buildReturnFlow(basePolicy)]);
  setFlowEngine(flows);
  const confirmations = new ConfirmationService(stores.confirmations);

  // v0.14：指标挂在 EventBus 上，AgentLoop 一行不改 ——
  // 这是 v0.4 把事件分发收敛到总线换来的第三次红利
  const metricsRegistry = opts.metrics ?? new MetricsRegistry();
  const metrics = buildMetrics(metricsRegistry);

  // v0.13：租户配置带进程内缓存。配置读多写极少，每请求查库是纯浪费；
  // 不设 TTL、只在写入时失效 —— 「改了配置要等几分钟生效」不该需要向运营解释
  const tenantConfigs = new CachedTenantConfig(stores.tenantConfigs);

  /**
   * 按租户解析出本次请求生效的配置。
   *
   * 安全规则是**叠加**：全局规则全部保留，租户只能追加。
   * 允许替换的话，一个租户的配置失误就能关掉全局的注入防护，且没有任何报错。
   */
  async function resolveForTenant(tenantId: string | null) {
    const cfg = await tenantConfigs.get(tenantId);
    return {
      inputRules: resolveSafetyRules(INPUT_RULES, cfg?.extraSafetyRules?.input),
      outputRules: resolveSafetyRules(OUTPUT_RULES, cfg?.extraSafetyRules?.output),
      returnPolicy: resolveReturnPolicy(basePolicy, cfg?.returnPolicy),
      quotaLimits: resolveQuotaLimits(quotaLimits, cfg?.quotaLimits),
    };
  }

  // ============ v1.1 归属校验 ============
  //
  // **跨租户访问一律按「不存在」处理**。403 等于确认「这个 id 存在，只是不属于你」——
  // 那就是一个存在性探测接口，拿它可以枚举出竞争对手有多少会话、多少退款单。
  //
  // 项目里已有同款先例并写明了理由：`/v1/tenants/:id/usage` 对不存在的租户返回全零
  // 而不是 404。这一版把它变成全局规则。

  /** 载入一个**属于调用方**的会话；不存在或不属于他，都返回 404 */
  async function loadOwnedSession(
    request: FastifyRequest,
    reply: FastifyReply,
    sessionId: string
  ): Promise<Session | null> {
    const session = await Session.restore(stores.sessions, sessionId);
    if (!session || !canAccessTenant(principalOf(request), session.getTenantId())) {
      notFound(reply, 'session_not_found', `会话 ${sessionId} 不存在`);
      return null;
    }
    return session;
  }

  /**
   * 校验路径里的租户号是不是调用方自己的。
   *
   * `admin` 可跨租户（运营后台）。非 admin 访问别人的租户 —— 同样按不存在处理。
   */
  function ownsTenantParam(
    request: FastifyRequest,
    reply: FastifyReply,
    tenantId: string,
    code: string
  ): boolean {
    if (canAccessTenant(principalOf(request), tenantId)) return true;
    notFound(reply, code, `租户 ${tenantId} 不存在`);
    return false;
  }

  /** 在默认管道上挂两个记忆中间件（顺序约束由 buildDefaultPipeline 内部保证） */
  function buildMemoryPipeline(o: {
    tracker: TokenTracker;
    session: Session;
    userId: string | null;
    tenantId: string | null;
    onIntent?: (state: IntentState) => void;
    onRouted?: (agent: DomainAgent) => void;
    onSafety?: (entry: SafetyAuditEntry) => void;
    onQuotaExceeded?: (scope: 'tenant' | 'session', reason: string) => void;
    resolved: Awaited<ReturnType<typeof resolveForTenant>>;
  }): Pipeline {
    return buildDefaultPipeline({
      tracker: o.tracker,
      maxTokens: config.maxTokensPerSession,
      maxMessages: 20,
      safety: {
        session: o.session,
        onVerdict: o.onSafety,
        // v0.13：按租户解析出的规则（全局 + 租户追加）
        inputScanner: new SafetyScanner(o.resolved.inputRules),
        outputScanner: new SafetyScanner(o.resolved.outputRules),
      },
      // v0.11：配额读账本而非进程内计数器 —— 这才让 maxTokensPerSession 名副其实
      quota: {
        service: new QuotaService(quotaCounter, o.resolved.quotaLimits),
        tenantId: o.tenantId,
        onExceeded: o.onQuotaExceeded,
      },
      enrich: [
        createProfileMiddleware({
          profiles: stores.profiles,
          // v1.1：画像按 (租户, 用户) 读。在此之前一个手机号在所有租户之间共享画像
          tenantId: o.tenantId ?? ANONYMOUS_TENANT,
          userId: o.userId,
        }),
        createIntentMiddleware({
          recognizer,
          session: o.session,
          onRecognized: o.onIntent,
        }),
        // 必须排在 intent 之后 —— 它的输入是 ctx.metadata.intent
        createRoutingMiddleware({ agents, onRouted: o.onRouted }),
      ],
      beforeTrim: [createCompactionMiddleware({ compactor, session: o.session })],
    });
  }

  /**
   * 每请求装配一个 AgentLoop。**进程内不缓存任何会话** ——
   * 代价是每次读一次库（v0.7 用 Redis 热缓存优化），
   * 收益是天然可水平扩容：任意实例都能接任意请求。
   */
  async function prepareTurn(
    body: ChatBody,
    principal: Principal,
    traceId: string,
    signal: AbortSignal | undefined,
    parentSpan: Span | undefined,
    hooks: {
      onIntent?: (state: IntentState) => void;
      onRouted?: (agent: DomainAgent) => void;
      onSafety?: (entry: SafetyAuditEntry) => void;
      onQuotaExceeded?: (scope: 'tenant' | 'session', reason: string) => void;
      onConfirmationRequired?: (c: ConfirmationRecord) => void;
    } = {}
  ): Promise<
    | {
        ok: true;
        session: Session;
        loop: AgentLoop;
        bus: EventBus;
        tracker: TokenTracker;
        /** v1.2：释放会话独占锁。**每条退出路径都必须调它** */
        release: () => Promise<void>;
      }
    | { ok: false; status: number; code: string; message: string }
  > {
    // ── v1.1 租户绑定 ──
    //
    // body 里的 `tenant_id` 从「数据来源」降级为「断言」：不一致直接 403，
    // **不是静默覆盖** —— 静默覆盖会让调用方以为自己写的生效了。
    // 这一条是整个 v1.1 的核心：在此之前，改一个 JSON 字段就能烧别人的额度。
    //
    // 唯一的例外是 `admin`：运营后台代客操作是真实需求，而 admin 本来就是
    // 「跨租户」这件事的显式载体。走 `canAccessTenant` 统一判定，
    // 不为它开第二条分支 —— 两处判定迟早会不一致。
    const boundTenant = body.tenant_id ?? principal.tenantId;
    if (!canAccessTenant(principal, boundTenant)) {
      return {
        ok: false,
        status: 403,
        code: 'tenant_mismatch',
        message: `凭证属于租户 ${principal.tenantId}，不能以租户 ${body.tenant_id} 的身份调用`,
      };
    }

    let session: Session | null;
    if (body.session_id) {
      session = await Session.restore(stores.sessions, body.session_id);
      // 不静默新建 —— 否则「会话丢失」会表现为「模型突然失忆」，极难排查。
      // 别人的会话与不存在的会话**返回同一个 404**：能借别人的会话发消息，
      // 等于既能读到他的历史，又能把账记到他头上
      if (!session || !canAccessTenant(principal, session.getTenantId())) {
        return {
          ok: false,
          status: 404,
          code: 'session_not_found',
          message: `会话 ${body.session_id} 不存在`,
        };
      }
    } else {
      session = await Session.create(stores.sessions, {
        userId: body.user_id,
        // **凭证说了算**。这是本版最重要的一行 ——
        // 非 admin 的 boundTenant 必然等于 principal.tenantId（上面已经拦过）
        tenantId: boundTenant,
      });
    }

    // ── v1.2 会话独占 ──
    //
    // 会话是追加式的，并发不会覆盖数据 —— 它造成的是更隐蔽的问题：
    // 两个请求各自 restore 一份快照、各自往同一条会话追加，消息顺序交错，
    // `tool_use` 与产生它的 `tool_result` 被别的消息隔开。
    // 而 v0.3 的投影逻辑对顺序敏感 —— 下一轮 restore 出来的历史直接是坏的。
    const locked = await stores.sessions.acquireTurnLock(
      session.getId(),
      opts.turnLockTtlMs ?? DEFAULT_TURN_LOCK_TTL_MS,
      Date.now()
    );
    if (!locked) {
      return {
        ok: false,
        status: 409,
        code: 'session_busy',
        // **不排队**：排队意味着调用方挂着等一次完整的模型调用，而他并不知道自己在排队
        message: `会话 ${session.getId()} 正有一轮对话在进行中，请等它结束后再发`,
      };
    }
    const release = () => stores.sessions.releaseTurnLock(session!.getId());

    let resolved: Awaited<ReturnType<typeof resolveForTenant>>;
    try {
      resolved = await resolveForTenant(session.getTenantId());
    } catch (err) {
      // 拿了锁之后的任何失败都必须先还锁，否则这条会话要卡满一个 TTL
      await release().catch(() => {});
      throw err;
    }

    // ── 配额预检 ──
    // 必须在这里做，而不是只靠管道里的 quota 中间件：SSE 一旦写出响应头就是 200，
    // 之后再发现租户欠费也没法改成 429 了。管道里那道检查负责工具循环中途越限，
    // 两道不是重复 —— 它们拦的是不同时刻。
    // 按租户配额判定 —— 不同租户可以有不同上限（v0.11 建立了账本维度，
    // 但上限一直是全局的；本版补上）
    const tenantQuota = new QuotaService(quotaCounter, resolved.quotaLimits);
    const preflight = await tenantQuota.check({
      tenantId: session.getTenantId(),
      sessionId: session.getId(),
    });
    if (!preflight.allowed && preflight.scope === 'tenant') {
      await release().catch(() => {});
      return {
        ok: false,
        status: 429,
        code: 'quota_exceeded',
        message: preflight.reason,
      };
    }

    const bus = new EventBus();
    collectFrom(bus, metrics, Date.now());
    const tracker = new TokenTracker();
    const tenantId = session.getTenantId() || ANONYMOUS_TENANT;
    const loop = new AgentLoop({
      config,
      registry: toolGateway,
      traceId,
      signal,
      tracer,
      parentSpan,
      session,
      bus,
      tracker,
      provider: opts.provider,
      pipeline: buildMemoryPipeline({
        tracker,
        session,
        userId: session.getUserId(),
        tenantId: session.getTenantId(),
        onIntent: hooks.onIntent,
        onRouted: hooks.onRouted,
        onSafety: (entry) => {
          metrics.safetyActions.inc({ stage: entry.stage, action: entry.action });
          hooks.onSafety?.(entry);
        },
        onQuotaExceeded: hooks.onQuotaExceeded,
        resolved,
      }),
      // v0.11：每次模型调用落一条账，并同步配额计数器。
      // 落账失败只警告不中断（AgentLoop 内部已 try/catch）—— 但配额检查失败必须拦，
      // 两者不对称是刻意的：记不上账是可以补的，放行超额是收不回来的。
      onUsage: async (record) => {
        const billable =
          record.usage.inputTokens +
          record.usage.outputTokens +
          (record.usage.cacheReadTokens ?? 0) +
          (record.usage.cacheWriteTokens ?? 0);

        await stores.usage.append({
          tenantId,
          sessionId: session!.getId(),
          model: record.model,
          inputTokens: record.usage.inputTokens,
          outputTokens: record.usage.outputTokens,
          cacheReadTokens: record.usage.cacheReadTokens ?? 0,
          cacheWriteTokens: record.usage.cacheWriteTokens ?? 0,
          billableTokens: billable,
          costUsd: record.costUsd,
          pricingResolved: record.pricingResolved,
          at: record.timestamp,
        });

        await tenantQuota.record({
          tenantId: session!.getTenantId(),
          sessionId: session!.getId(),
          billableTokens: billable,
        });
      },
      // v0.10：delta 必须过脱敏器再出门。少了这一行，afterTurn 的脱敏只保护
      // 非流式返回值，未脱敏的手机号已经先一步打到用户屏幕上了（v0.4 的洞）。
      redactor: () =>
        new StreamingRedactor(
          SafetyScanner.forOutput(),
          config.safetyLag ?? DEFAULT_SAFETY_LAG
        ),
      // v0.12：高风险工具从「一律拒绝」改为「生成确认单」。
      //
      // v0.6 写死 `async () => false`，理由是服务端没有交互式确认通道 ——
      // 但拒绝的话术被伪装成「用户取消了该操作」，而用户从没取消过任何东西。
      // 模型据此推断事情办完了，回客户一句「已处理」。**退款在线上根本执行不了，
      // 且日志里查不到任何异常。**
      onConfirm: async (toolName, input) => {
        const outcome = await confirmations.require({
          sessionId: session!.getId(),
          toolName,
          toolInput: input,
          summary: summarizeToolCall(toolName, input),
        });

        if (outcome.decision === 'approved') {
          metrics.confirmations.inc({ outcome: 'approved' });
          return { approved: true };
        }

        if (outcome.decision === 'rejected') {
          metrics.confirmations.inc({ outcome: 'rejected' });
          return {
            approved: false,
            message: `客户已拒绝该操作（确认单 ${outcome.confirmation.id}）。请勿执行，并询问客户还需要什么帮助。`,
          };
        }

        metrics.confirmations.inc({ outcome: 'required' });
        hooks.onConfirmationRequired?.(outcome.confirmation);
        return {
          approved: false,
          // 这句话必须是真的：模型据此告诉客户去确认，而不是宣布已处理
          message:
            `该操作需要客户确认后才能执行，已生成确认单 ${outcome.confirmation.id}。\n` +
            `确认内容：${outcome.confirmation.summary}\n` +
            '请向客户复述上述内容并请其确认；确认后本操作会自动执行。',
        };
      },
    });

    return { ok: true, session, loop, bus, tracker, release };
  }

  // ============ SSE 流式 ============

  app.post<{ Body: ChatBody }>(
    '/v1/chat',
    { schema: { body: CHAT_BODY_SCHEMA } },
    async (request, reply) => {
      const principal = requireScope(request, reply, 'chat');
      if (!principal) return reply;

      let writer: SseWriter | undefined;
      // v1.2：优先接住上游的 traceparent —— 网关/前端已经开了链路，
      // 这里另起一条会让同一次用户操作在链路图上断成两截
      const upstream = parseTraceparent(request.headers.traceparent as string | undefined);
      const traceId =
        upstream?.traceId || (request.headers['x-trace-id'] as string) || newTraceId();
      const httpSpan = tracer.startSpan('http.chat.stream', {
        traceId,
        parentSpanId: upstream?.spanId,
        attributes: { tenant: principal.tenantId, streaming: true },
      });
      // v1.0：客户端断开 → 中断本轮。v0.6 只停止写出，模型继续跑完 ——
      // 那不是浪费 CPU，是在给一个已经没人看的回答付钱
      const controller = new AbortController();
      const prepared = await prepareTurn(request.body, principal, traceId, controller.signal, httpSpan, {
        onIntent: (state) =>
          writer?.writeIntent({
            intent: state.intent,
            confidence: state.confidence,
            phase: state.phase,
            slots: state.slots as Record<string, unknown>,
            missing: state.missing,
          }),
        onRouted: (agent) =>
          writer?.writeRouting({
            agent: agent.id,
            name: agent.name,
            tools: agent.toolNames,
          }),
        onSafety: (entry) =>
          writer?.writeSafety({
            stage: entry.stage,
            action: entry.action,
            // 只发规则名，不发命中原文
            rules: [...new Set(entry.matches.map((m) => m.ruleName))],
          }),
        onQuotaExceeded: (scope, reason) => writer?.writeQuota({ scope, reason }),
        onConfirmationRequired: (c) =>
          writer?.writeConfirmationRequired({
            confirmation_id: c.id,
            tool: c.toolName,
            summary: c.summary,
          }),
      });
      if (!prepared.ok) {
        httpSpan.setAttribute('http.status', prepared.status);
        httpSpan.setAttribute('error.code', prepared.code);
        httpSpan.end();
        return reply
          .status(prepared.status)
          .send(errorBody(prepared.code, prepared.message));
      }

      const { session, loop, bus, release } = prepared;
      httpSpan.setAttribute('session', session.getId());

      // ── 幂等（SSE 版）──
      //
      // **刻意不重放流**：流里有 `confirmation_required` 这类当时才成立的事件，
      // 重放一条旧流会让客户端弹出一个早已被决策过的确认框。
      // 改为返回 409 + session_id —— **指路比伪造一条流诚实**。
      const idemKey = readIdempotencyKey(request.headers as Record<string, unknown>);
      if (idemKey) {
        const claim = await stores.idempotency.claim({
          key: idemKey,
          keyId: principal.keyId,
          endpoint: 'POST /v1/chat',
          requestHash: requestFingerprint(request.body),
          ttlMs: opts.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS,
          now: Date.now(),
        });
        if (!claim.claimed) {
          const e = claim.existing;
          const code =
            e.requestHash !== requestFingerprint(request.body)
              ? 'idempotency_key_reused'
              : e.status === 'in_progress'
                ? 'request_in_progress'
                : 'already_completed';
          return reply.status(409).send({
            error: {
              code,
              message: `幂等键 ${idemKey} 已被使用（${code}）`,
              ...(e.responseBody as Record<string, unknown> | null),
            },
          });
        }
      }

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Session-Id': session.getId(),
        // 链路号回给调用方 —— 客户报障时给这个号就能定位整条链路
        'X-Trace-Id': traceId,
      });

      writer = new SseWriter(reply.raw);
      // 客户端断开就停止写出（本版不中断 Loop —— 真正的中断归 v1.0 韧性版）
      request.raw.on('close', () => {
        writer.markClosed();
        controller.abort();
      });

      writer.writeSession(session.getId());
      bus.subscribe((event: AgentEvent) => writer.writeEvent(event));

      try {
        const turn = await loop.run(request.body.message);
        // v1.2：失败的轮次不该被幂等键固化。判定改用**结构化 outcome**，
        // 不再靠 v1.1 那个「订阅 error 事件旁路拼凑」的做法
        if (idemKey && turn.outcome !== 'error') {
          // 存的是**指路信息**而不是流：重复请求会拿到 409 + 这个 session_id，
          // 调用方据此去 /v1/sessions/:id/messages 取结果
          await stores.idempotency.complete({
            key: idemKey,
            keyId: principal.keyId,
            responseStatus: 409,
            responseBody: { session_id: session.getId(), trace_id: traceId },
          });
        }
      } catch (err) {
        // 失败释放占位 —— 失败往往是瞬时的，该让调用方能真的重来一次
        if (idemKey) await stores.idempotency.release(idemKey, principal.keyId).catch(() => {});
        writer.writeError('internal_error', (err as Error).message);
      } finally {
        // 无论成败都要还锁 —— 靠 TTL 兜底意味着一次异常会让这条会话罚站一分钟
        await release().catch(() => {});
        httpSpan.end();
        writer.close();
      }

      // 已经手工接管了响应流
      return reply;
    }
  );

  // ============ 非流式（不支持 SSE 的调用方） ============

  app.post<{ Body: ChatBody }>(
    '/v1/chat/sync',
    { schema: { body: CHAT_BODY_SCHEMA } },
    async (request, reply) => {
      const principal = requireScope(request, reply, 'chat');
      if (!principal) return reply;

      const upstream = parseTraceparent(request.headers.traceparent as string | undefined);
      const traceId =
        upstream?.traceId || (request.headers['x-trace-id'] as string) || newTraceId();
      const httpSpan = tracer.startSpan('http.chat.sync', {
        traceId,
        parentSpanId: upstream?.spanId,
        attributes: { tenant: principal.tenantId, streaming: false },
      });

      // 非流式端点是**响应可以被完整存下来重放**的那一类，所以走完整的幂等语义。
      // 这一层挡的是最贵的一种重复：客户端超时重发 → 退款被执行两次。
      // v0.3/v0.12/v1.0 三版都在防重复执行，但入口敞着的时候那三道防线一道都不生效
      const outcome = await withIdempotency(
        stores.idempotency,
        principal,
        readIdempotencyKey(request.headers as Record<string, unknown>),
        'POST /v1/chat/sync',
        request.body,
        async (): Promise<IdempotentOutcome> => {
          const prepared = await prepareTurn(request.body, principal, traceId, undefined, httpSpan);
          if (!prepared.ok) {
            return {
              status: prepared.status,
              body: errorBody(prepared.code, prepared.message),
            };
          }

          const { session, loop, bus, tracker, release } = prepared;
          const blocked: { by: string; reason: string }[] = [];
          // v0.13：非流式调用方也要能拿到结构化数据，否则只能去解析 reply 里的中文
          const artifacts: Array<{ tool: string; artifact: ToolArtifact }> = [];
          bus.subscribe((event) => {
            if (event.type === 'blocked') blocked.push({ by: event.by, reason: event.reason });
            if (event.type === 'artifact') {
              artifacts.push({ tool: event.toolName, artifact: event.artifact });
            }
          });

          let turn: Awaited<ReturnType<typeof loop.run>>;
          try {
            turn = await loop.run(request.body.message);
          } finally {
            await release().catch(() => {});
          }
          const summary = tracker.getSummary();

          // v1.1 靠订阅 error 事件旁路判断失败；v1.2 有了结构化 outcome，
          // 判定与错误码都直接来自轮次结果 —— 少一处需要同步维护的真相。
          //
          // `retryable` 原样透出：调用方据它决定「换个说法再问一次」还是「转人工」。
          // 让每个接入方自己猜，等于每家发明一套不同的判断逻辑
          // **只有 `error` 是传输层失败**（下游挂了），走 5xx。
          // `blocked` 与 `max_turns` 是**业务上成立的结果** ——
          // 客户问了不该问的、或者问题太复杂没收敛，这两件事都发生在
          // 一次正常的交互里，用 5xx 表达会让监控上的错误率变成噪声（v1.0 定的调）。
          // 它们靠响应体里的 `outcome` 与调用方沟通，而不是靠状态码。
          if (turn.outcome === 'error') {
            return {
              status: 502,
              body: {
                error: {
                  code: 'upstream_error',
                  message: turn.error!.message,
                  retryable: turn.error!.retryable,
                },
                session_id: session.getId(),
                trace_id: traceId,
              },
            };
          }

          return {
            status: 200,
            body: {
              session_id: session.getId(),
              trace_id: traceId,
              // v1.2：轮次结果显式给出。在此之前调用方只能看 reply 的内容猜
              //（「这句话是回答，还是一句伪装成回答的失败说明？」）
              outcome: turn.outcome,
              reply: turn.reply,
              error: turn.error
                ? {
                    code: turn.error.code,
                    message: turn.error.message,
                    retryable: turn.error.retryable,
                  }
                : undefined,
              artifacts: artifacts.map((a) => ({
                tool: a.tool,
                type: a.artifact.type,
                data: a.artifact.data,
              })),
              blocked: blocked.length > 0 ? blocked : undefined,
              usage: {
                input_tokens: summary.totalInputTokens,
                output_tokens: summary.totalOutputTokens,
                cost_usd: Number(summary.totalCostUsd.toFixed(6)),
              },
            },
          };
        },
        { ttlMs: opts.idempotencyTtlMs }
      );

      httpSpan.setAttribute('http.status', outcome.status);
      if (outcome.status >= 500) httpSpan.recordError(new Error(`HTTP ${outcome.status}`));
      httpSpan.end();

      return reply
        .status(outcome.status)
        .header('X-Trace-Id', traceId)
        // 让调用方能分辨「这次真的执行了」和「这是上次的结果」——
        // 不告诉他的话，重放会被当成一次新的成功执行
        .header('Idempotent-Replay', outcome.replayed ? 'true' : 'false')
        .send(outcome.body);
    }
  );

  // ============ 会话查询 ============

  app.get<{ Params: { id: string } }>('/v1/sessions/:id', async (request, reply) => {
    if (!requireScope(request, reply, 'read')) return reply;
    const session = await loadOwnedSession(request, reply, request.params.id);
    if (!session) return reply;
    return reply.send({
      session_id: session.getId(),
      user_id: session.getUserId(),
      tenant_id: session.getTenantId(),
      message_count: session.getMessages().length,
      entry_count: session.getEntries().length,
    });
  });

  app.get<{ Params: { id: string } }>(
    '/v1/sessions/:id/messages',
    async (request, reply) => {
      if (!requireScope(request, reply, 'read')) return reply;
      const session = await loadOwnedSession(request, reply, request.params.id);
      if (!session) return reply;
      return reply.send({
        session_id: session.getId(),
        messages: session.getMessages().map((m) => ({
          role: m.role,
          content: m.content,
          tool_uses: m.toolUses?.map((t) => ({ id: t.id, name: t.name })),
          tool_use_id: m.toolResult?.toolUseId,
        })),
      });
    }
  );

  // ============ 用户画像（v0.7 长期记忆） ============

  app.get<{ Params: { id: string } }>('/v1/users/:id/profile', async (request, reply) => {
    const principal = requireScope(request, reply, 'read');
    if (!principal) return reply;

    // v1.1：画像按 (租户, 用户) 读。在此之前主键是 user_id 单列 ——
    // 而 user_id 在真实接入中通常是手机号，**可枚举**：
    // 任何租户拿一个手机号就能读到别家客户的称呼、收货偏好、投诉备注
    const profile = await stores.profiles.get(principal.tenantId, request.params.id);
    if (!profile) {
      return reply
        .status(404)
        .send(errorBody('profile_not_found', `用户 ${request.params.id} 无画像`));
    }
    return reply.send({
      user_id: profile.userId,
      display_name: profile.displayName,
      preferences: profile.preferences,
      notes: profile.notes,
      updated_at: profile.updatedAt,
    });
  });

  // ============ 异步确认与业务流（v0.12） ============

  const DECIDE_SCHEMA = {
    type: 'object',
    required: ['approved'],
    properties: {
      approved: { type: 'boolean' },
      decided_by: { type: 'string' },
    },
    additionalProperties: false,
  } as const;

  app.post<{ Params: { id: string }; Body: { approved: boolean; decided_by?: string } }>(
    '/v1/confirmations/:id',
    { schema: { body: DECIDE_SCHEMA } },
    async (request, reply) => {
      const principal = requireScope(request, reply, 'write');
      if (!principal) return reply;

      const existing = await confirmations.get(request.params.id);
      // 确认单没有租户列 —— 归属的唯一真相在它所属的 session 上。
      // **决策别人的退款是本版拦下的最贵的一件事**：在此之前，
      // 猜到一个确认单 id 就能批准别家客户的退款申请
      const owner = existing
        ? await Session.restore(stores.sessions, existing.sessionId)
        : null;
      if (!existing || !owner || !canAccessTenant(principal, owner.getTenantId())) {
        return notFound(
          reply,
          'confirmation_not_found',
          `确认单 ${request.params.id} 不存在`
        );
      }

      // v1.1：幂等键包住整个决策。
      //
      // v0.12 让第二次决策返回 409「已处理过」，那对**真的重复决策**是对的；
      // 但调用方网络超时重发时，他并没有做错任何事，却拿到一个错误 ——
      // 于是运营界面显示「审批失败」，而后台其实已经批了。
      // 幂等键正好把这两种情形分开：带键的是重发，不带键的是重复决策。
      const outcome = await withIdempotency(
        stores.idempotency,
        principal,
        readIdempotencyKey(request.headers as Record<string, unknown>),
        `POST /v1/confirmations/${request.params.id}`,
        request.body,
        async (): Promise<IdempotentOutcome> => {
          const decided = await confirmations.decide(
            request.params.id,
            request.body.approved,
            request.body.decided_by ?? 'customer'
          );

          // decide 返回 null = 已经被决策过。**409 而不是 200** ——
          // 静默接受第二次决策会让「谁批的」变成一笔糊涂账
          if (!decided) {
            return {
              status: 409,
              body: errorBody(
                'confirmation_already_decided',
                `确认单 ${request.params.id} 已处理过（当前状态 ${existing.status}），不能重复决策`
              ),
            };
          }

          return {
            status: 200,
            body: {
              confirmation_id: decided.id,
              status: decided.status,
              decided_by: decided.decidedBy,
              summary: decided.summary,
              // 明确告诉调用方还要再发一轮，操作才会真正执行
              next:
                decided.status === 'approved'
                  ? '请再发一轮对话（如「已确认」），操作将自动执行'
                  : null,
            },
          };
        },
        { ttlMs: opts.idempotencyTtlMs }
      );

      return reply
        .status(outcome.status)
        .header('Idempotent-Replay', outcome.replayed ? 'true' : 'false')
        .send(outcome.body);
    }
  );

  app.get<{ Params: { id: string } }>(
    '/v1/sessions/:id/confirmations',
    async (request, reply) => {
      if (!requireScope(request, reply, 'read')) return reply;
      // 确认单本身没有租户列 —— 归属的唯一真相在 session 上。
      // 多一次查询，换的是不引入第二处租户来源（两处迟早会不一致）
      if (!(await loadOwnedSession(request, reply, request.params.id))) return reply;

      const list = await confirmations.listBySession(request.params.id, 50);
      return reply.send({
        session_id: request.params.id,
        confirmations: list.map((c) => ({
          confirmation_id: c.id,
          tool: c.toolName,
          summary: c.summary,
          status: c.status,
          decided_by: c.decidedBy ?? null,
          created_at: c.createdAt,
        })),
      });
    }
  );

  app.get<{ Params: { id: string } }>('/v1/flows/:id', async (request, reply) => {
    const principal = requireScope(request, reply, 'read');
    if (!principal) return reply;

    const flow = await flows.get(request.params.id);
    // 同确认单：流程的租户归属在 session 上。退货流程里有订单号、金额、理由 ——
    // 全是别家的经营数据
    const owner = flow ? await Session.restore(stores.sessions, flow.sessionId) : null;
    if (!flow || !owner || !canAccessTenant(principal, owner.getTenantId())) {
      return notFound(reply, 'flow_not_found', `流程 ${request.params.id} 不存在`);
    }

    const history = await flows.history(flow.id);
    return reply.send({
      flow_id: flow.id,
      kind: flow.kind,
      order_id: flow.subjectId,
      state: flow.state,
      state_label: RETURN_STATE_LABELS[flow.state] ?? flow.state,
      available_events: flows.availableEvents(flow),
      data: flow.data,
      transitions: history.map((t) => ({
        from: t.from,
        to: t.to,
        event: t.event,
        actor: t.actor,
        note: t.note ?? null,
        at: t.at,
      })),
    });
  });

  // ============ 结构化数据回放与租户配置（v0.13） ============

  /**
   * 回放整个会话产出的结构化数据。
   *
   * 从 session 的 tool_result 条目里提取 —— 客户端断线重连后不必重跑对话
   * 就能恢复界面（商品卡、订单卡、流程状态）。
   */
  app.get<{ Params: { id: string } }>(
    '/v1/sessions/:id/artifacts',
    async (request, reply) => {
      if (!requireScope(request, reply, 'read')) return reply;
      const session = await loadOwnedSession(request, reply, request.params.id);
      if (!session) return reply;

      const artifacts = session
        .getEntries()
        .filter((e) => e.type === 'tool_result')
        .map((e) => e.data as { toolUseId: string; result: { artifact?: ToolArtifact } })
        .filter((d) => d.result?.artifact)
        .map((d) => ({
          tool_use_id: d.toolUseId,
          type: d.result.artifact!.type,
          data: d.result.artifact!.data,
        }));

      return reply.send({ session_id: request.params.id, artifacts });
    }
  );

  const TENANT_CONFIG_SCHEMA = {
    type: 'object',
    properties: {
      return_policy: {
        type: 'object',
        properties: {
          windowDays: { type: 'number' },
          autoApproveAmount: { type: 'number' },
        },
        additionalProperties: false,
      },
      quota_limits: {
        type: 'object',
        properties: {
          perSession: { type: 'number' },
          perTenant: { type: 'number' },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  } as const;

  app.put<{
    Params: { id: string };
    Body: { return_policy?: Record<string, number>; quota_limits?: Record<string, number> };
  }>(
    '/v1/tenants/:id/config',
    { schema: { body: TENANT_CONFIG_SCHEMA } },
    async (request, reply) => {
      if (!requireScope(request, reply, 'write')) return reply;
      // 改别人的配额上限 / 售后政策 —— 按不存在处理
      if (!ownsTenantParam(request, reply, request.params.id, 'tenant_not_found')) {
        return reply;
      }

      // 安全规则刻意**不通过这个接口配置** —— HTTP 传正则再服务端 new RegExp，
      // 等于开了一个 ReDoS 入口。规则变更走部署，不走运行时 API
      const saved = await tenantConfigs.upsert({
        tenantId: request.params.id,
        returnPolicy: request.body.return_policy,
        quotaLimits: request.body.quota_limits,
      });

      return reply.send({
        tenant_id: saved.tenantId,
        return_policy: saved.returnPolicy,
        quota_limits: saved.quotaLimits,
        updated_at: saved.updatedAt,
      });
    }
  );

  app.get<{ Params: { id: string } }>('/v1/tenants/:id/config', async (request, reply) => {
    if (!requireScope(request, reply, 'read')) return reply;
    if (!ownsTenantParam(request, reply, request.params.id, 'tenant_not_found')) {
      return reply;
    }

    const cfg = await tenantConfigs.get(request.params.id);
    const resolved = await resolveForTenant(request.params.id);
    return reply.send({
      tenant_id: request.params.id,
      configured: cfg !== null,
      // 返回**生效值**而不只是配置值 —— 运营要看的是「现在到底按什么执行」
      effective: {
        return_policy: resolved.returnPolicy,
        quota_limits: resolved.quotaLimits,
        input_rule_count: resolved.inputRules.length,
        output_rule_count: resolved.outputRules.length,
      },
    });
  });

  // ============ 用量查询（v0.11） ============

  app.get<{ Params: { id: string }; Querystring: { since?: string; limit?: string } }>(
    '/v1/tenants/:id/usage',
    async (request, reply) => {
      if (!requireScope(request, reply, 'read')) return reply;
      // 用量 = 账单。看别家的账单既是商业机密泄露，也是竞争情报
      if (!ownsTenantParam(request, reply, request.params.id, 'tenant_not_found')) {
        return reply;
      }

      const since = request.query.since ? Number(request.query.since) : undefined;
      if (since !== undefined && !Number.isFinite(since)) {
        return reply
          .status(400)
          .send(errorBody('invalid_since', 'since 必须是毫秒时间戳'));
      }

      const limit = Math.min(Number(request.query.limit) || 50, 200);
      const [summary, records] = await Promise.all([
        stores.usage.sumByTenant(request.params.id, since),
        stores.usage.listByTenant(request.params.id, limit),
      ]);

      // 租户不存在与租户零用量**返回同一个结果**（全零）：
      // 用 404 区分等于给出一个租户是否存在的探测接口
      return reply.send({
        tenant_id: request.params.id,
        since: since ?? null,
        limits: {
          per_session: quotaLimits.perSession,
          per_tenant: quotaLimits.perTenant,
        },
        summary: {
          billable_tokens: summary.billableTokens,
          input_tokens: summary.inputTokens,
          output_tokens: summary.outputTokens,
          cache_read_tokens: summary.cacheReadTokens,
          cache_write_tokens: summary.cacheWriteTokens,
          cost_usd: Number(summary.costUsd.toFixed(10)),
          call_count: summary.callCount,
        },
        records: records.map((r) => ({
          session_id: r.sessionId,
          model: r.model,
          billable_tokens: r.billableTokens,
          cost_usd: Number(r.costUsd.toFixed(10)),
          pricing_resolved: r.pricingResolved ?? null,
          at: r.at,
        })),
      });
    }
  );

  // ============ 领域 Agent 列表（v0.9） ============

  app.get('/v1/agents', async (request, reply) => {
    if (!requireScope(request, reply, 'read')) return reply;
    return reply.send({
      agents: agents.getAll().map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        intents: a.intents,
        tools: a.toolNames.length > 0 ? a.toolNames : '*',
      })),
    });
  });

  // ============ 指标与安全报表（v0.14） ============

  app.get('/metrics', async (_request, reply) => {
    // Prometheus 规定的 content-type，版本号不能省 —— 少了它某些抓取端会拒绝
    return reply
      .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(metricsRegistry.render());
  });

  app.get<{ Params: { id: string } }>(
    '/v1/sessions/:id/safety-report',
    async (request, reply) => {
      if (!requireScope(request, reply, 'read')) return reply;
      const session = await loadOwnedSession(request, reply, request.params.id);
      if (!session) return reply;

      const report = buildSafetyReport(readSafetyAudit(session), 1);
      return reply.send({
        session_id: request.params.id,
        // 口径写进响应体，避免调用方把「拦截构成」当成「误杀率」
        note: '本报表统计拦截构成；真实误杀率需人工标注，此处提供筛查线索',
        ...report,
      });
    }
  );

  // ============ 链路查询（v1.2） ============

  /**
   * 查一条链路的 span。
   *
   * ⚠️ 读的是**本实例**的内存环形缓冲 —— 多实例部署下只能看到打到这台机器的那部分。
   * 要全局查询就该上真 collector（OTLP 已经通了）。这个接口的定位是
   * 「没有 collector 时也能看链路」，不是替代 collector。
   */
  app.get<{ Params: { id: string } }>('/v1/traces/:id', async (request, reply) => {
    const principal = requireScope(request, reply, 'read');
    if (!principal) return reply;

    const spans = spanBuffer.byTrace(request.params.id);

    // **归属由 http span 决定**，而不是逐个 span 过滤。
    // 逐个过滤是错的：`model.chat` / `tool.execute` 上根本没有 tenant 属性，
    // 它们会直接漏给任何人 —— 而工具 span 的属性里带着工具名和参数。
    // 一条链路属于发起它的那个请求，这是唯一说得通的归属定义。
    const root = spans.find((s) => s.name.startsWith('http.'));
    if (!root || !canAccessTenant(principal, String(root.attributes.tenant ?? ''))) {
      return notFound(reply, 'trace_not_found', `链路 ${request.params.id} 不存在`);
    }
    const own = spans;

    const start = Math.min(...own.map((s) => s.startTime));
    return reply.send({
      trace_id: request.params.id,
      note: '本接口读的是本实例内存缓冲；多实例下请以 OTLP collector 为准',
      duration_ms: Math.max(...own.map((s) => s.endTime)) - start,
      spans: own.map((s) => ({
        span_id: s.spanId,
        parent_span_id: s.parentSpanId ?? null,
        name: s.name,
        // 相对偏移比绝对时间戳好读 —— 看链路时关心的是"第几毫秒发生了什么"
        offset_ms: s.startTime - start,
        duration_ms: s.endTime - s.startTime,
        status: s.status,
        error: s.error ?? null,
        attributes: s.attributes,
      })),
    });
  });

  // ============ 健康检查 ============

  /**
   * v1.0 优雅退出：收到信号后立刻置位。
   *
   * 健康检查马上转不健康，让负载均衡停止派新活 ——
   * 而进程**继续服务在途请求**。这两件事必须分开：
   * 「不接新活」和「立刻停机」差着所有在途请求的成败。
   */
  let draining = false;
  app.decorate('startDraining', () => {
    draining = true;
  });

  app.get('/healthz', async (_request, reply) => {
    if (draining) {
      return reply.status(503).send({
        status: 'draining',
        message: '正在优雅退出，不再接受新流量；在途请求仍会完成',
      });
    }
    try {
      await stores.db.query('SELECT 1');
      return reply.send({
        status: 'ok',
        engine: stores.db.engine,
        cache: stores.cache.kind,
        tool_gateway: opts.toolGateway ? 'remote' : 'local',
        auth: opts.auth?.disabled ? 'disabled' : 'enabled',
        // **进程内限流在多实例下是 N 倍配额**。这个事实必须暴露给运维 ——
        // 「限流失准」这件事，运维不知道就等于没有限流
        rate_limit: rateLimiter.kind,
        tracing: tracer.exporterKind,
      });
    } catch (err) {
      return reply
        .status(503)
        .send(errorBody('storage_unavailable', (err as Error).message));
    }
  });

  // 统一错误形状：校验失败也走 {error: {code, message}}
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error.validation) {
      return reply.status(400).send(errorBody('invalid_request', error.message));
    }
    return reply
      .status(error.statusCode ?? 500)
      .send(errorBody('internal_error', error.message));
  });

  return app;
}
