import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
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
import { SafetyScanner } from '../safety/scanner.js';
import { DEFAULT_SAFETY_LAG } from '../safety/rules.js';
import { buildToolRegistry } from '../tools/index.js';
import { setRefundStore } from '../tools/refund-store.js';
import { SYSTEM_PROMPT } from '../prompts/system-prompt.js';
import { ResponseScorer } from '../evaluation/response-scorer.js';
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
}

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

  // 工具注册表与退款 store 是进程级的，装配一次
  const registry = buildToolRegistry();
  setRefundStore(stores.refunds);

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
  const quota = new QuotaService(
    await createQuotaCounter(stores.usage, process.env.REDIS_URL),
    quotaLimits
  );

  // v0.12：流程引擎与确认服务都是进程级的，装配一次。
  // 会话号不在这里绑定 —— 工具执行时从 ToolContext 拿，否则并发下会串会话。
  const flows = new FlowEngine(stores.flows, [
    buildReturnFlow(opts.returnPolicy ?? DEFAULT_RETURN_POLICY),
  ]);
  setFlowEngine(flows);
  const confirmations = new ConfirmationService(stores.confirmations);

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
  }): Pipeline {
    return buildDefaultPipeline({
      tracker: o.tracker,
      maxTokens: config.maxTokensPerSession,
      maxMessages: 20,
      safety: { session: o.session, onVerdict: o.onSafety },
      // v0.11：配额读账本而非进程内计数器 —— 这才让 maxTokensPerSession 名副其实
      quota: {
        service: quota,
        tenantId: o.tenantId,
        onExceeded: o.onQuotaExceeded,
      },
      enrich: [
        createProfileMiddleware({ profiles: stores.profiles, userId: o.userId }),
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
    hooks: {
      onIntent?: (state: IntentState) => void;
      onRouted?: (agent: DomainAgent) => void;
      onSafety?: (entry: SafetyAuditEntry) => void;
      onQuotaExceeded?: (scope: 'tenant' | 'session', reason: string) => void;
      onConfirmationRequired?: (c: ConfirmationRecord) => void;
    } = {}
  ): Promise<
    | { ok: true; session: Session; loop: AgentLoop; bus: EventBus; tracker: TokenTracker }
    | { ok: false; status: number; code: string; message: string }
  > {
    let session: Session | null;
    if (body.session_id) {
      session = await Session.restore(stores.sessions, body.session_id);
      if (!session) {
        // 不静默新建 —— 否则「会话丢失」会表现为「模型突然失忆」，极难排查
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
        tenantId: body.tenant_id,
      });
    }

    // ── 配额预检 ──
    // 必须在这里做，而不是只靠管道里的 quota 中间件：SSE 一旦写出响应头就是 200，
    // 之后再发现租户欠费也没法改成 429 了。管道里那道检查负责工具循环中途越限，
    // 两道不是重复 —— 它们拦的是不同时刻。
    const preflight = await quota.check({
      tenantId: session.getTenantId(),
      sessionId: session.getId(),
    });
    if (!preflight.allowed && preflight.scope === 'tenant') {
      return {
        ok: false,
        status: 429,
        code: 'quota_exceeded',
        message: preflight.reason,
      };
    }

    const bus = new EventBus();
    const tracker = new TokenTracker();
    const tenantId = session.getTenantId() || ANONYMOUS_TENANT;
    const loop = new AgentLoop({
      config,
      registry,
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
        onSafety: hooks.onSafety,
        onQuotaExceeded: hooks.onQuotaExceeded,
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

        await quota.record({
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
      scorer: new ResponseScorer(),
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

        if (outcome.decision === 'approved') return { approved: true };

        if (outcome.decision === 'rejected') {
          return {
            approved: false,
            message: `客户已拒绝该操作（确认单 ${outcome.confirmation.id}）。请勿执行，并询问客户还需要什么帮助。`,
          };
        }

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

    return { ok: true, session, loop, bus, tracker };
  }

  // ============ SSE 流式 ============

  app.post<{ Body: ChatBody }>(
    '/v1/chat',
    { schema: { body: CHAT_BODY_SCHEMA } },
    async (request, reply) => {
      let writer: SseWriter | undefined;
      const prepared = await prepareTurn(request.body, {
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
        return reply
          .status(prepared.status)
          .send(errorBody(prepared.code, prepared.message));
      }

      const { session, loop, bus } = prepared;

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Session-Id': session.getId(),
      });

      writer = new SseWriter(reply.raw);
      // 客户端断开就停止写出（本版不中断 Loop —— 真正的中断归 v1.0 韧性版）
      request.raw.on('close', () => writer.markClosed());

      writer.writeSession(session.getId());
      bus.subscribe((event: AgentEvent) => writer.writeEvent(event));

      try {
        await loop.run(request.body.message);
      } catch (err) {
        writer.writeError('internal_error', (err as Error).message);
      } finally {
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
      const prepared = await prepareTurn(request.body);
      if (!prepared.ok) {
        return reply
          .status(prepared.status)
          .send(errorBody(prepared.code, prepared.message));
      }

      const { session, loop, bus, tracker } = prepared;
      const blocked: { by: string; reason: string }[] = [];
      bus.subscribe((event) => {
        if (event.type === 'blocked') blocked.push({ by: event.by, reason: event.reason });
      });

      const reply_text = await loop.run(request.body.message);
      const summary = tracker.getSummary();

      return reply.send({
        session_id: session.getId(),
        reply: reply_text,
        blocked: blocked.length > 0 ? blocked : undefined,
        usage: {
          input_tokens: summary.totalInputTokens,
          output_tokens: summary.totalOutputTokens,
          cost_usd: Number(summary.totalCostUsd.toFixed(6)),
        },
      });
    }
  );

  // ============ 会话查询 ============

  app.get<{ Params: { id: string } }>('/v1/sessions/:id', async (request, reply) => {
    const session = await Session.restore(stores.sessions, request.params.id);
    if (!session) {
      return reply
        .status(404)
        .send(errorBody('session_not_found', `会话 ${request.params.id} 不存在`));
    }
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
      const session = await Session.restore(stores.sessions, request.params.id);
      if (!session) {
        return reply
          .status(404)
          .send(errorBody('session_not_found', `会话 ${request.params.id} 不存在`));
      }
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
    const profile = await stores.profiles.get(request.params.id);
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
      const existing = await confirmations.get(request.params.id);
      if (!existing) {
        return reply
          .status(404)
          .send(errorBody('confirmation_not_found', `确认单 ${request.params.id} 不存在`));
      }

      const decided = await confirmations.decide(
        request.params.id,
        request.body.approved,
        request.body.decided_by ?? 'customer'
      );

      // decide 返回 null = 已经被决策过。**409 而不是 200** ——
      // 静默接受第二次决策会让「谁批的」变成一笔糊涂账
      if (!decided) {
        return reply
          .status(409)
          .send(
            errorBody(
              'confirmation_already_decided',
              `确认单 ${request.params.id} 已处理过（当前状态 ${existing.status}），不能重复决策`
            )
          );
      }

      return reply.send({
        confirmation_id: decided.id,
        status: decided.status,
        decided_by: decided.decidedBy,
        summary: decided.summary,
        // 明确告诉调用方还要再发一轮，操作才会真正执行
        next: decided.status === 'approved'
          ? '请再发一轮对话（如「已确认」），操作将自动执行'
          : null,
      });
    }
  );

  app.get<{ Params: { id: string } }>(
    '/v1/sessions/:id/confirmations',
    async (request, reply) => {
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
    const flow = await flows.get(request.params.id);
    if (!flow) {
      return reply
        .status(404)
        .send(errorBody('flow_not_found', `流程 ${request.params.id} 不存在`));
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

  // ============ 用量查询（v0.11） ============

  app.get<{ Params: { id: string }; Querystring: { since?: string; limit?: string } }>(
    '/v1/tenants/:id/usage',
    async (request, reply) => {
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

  app.get('/v1/agents', async (_request, reply) =>
    reply.send({
      agents: agents.getAll().map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        intents: a.intents,
        tools: a.toolNames.length > 0 ? a.toolNames : '*',
      })),
    })
  );

  // ============ 健康检查 ============

  app.get('/healthz', async (_request, reply) => {
    try {
      await stores.db.query('SELECT 1');
      return reply.send({
        status: 'ok',
        engine: stores.db.engine,
        cache: stores.cache.kind,
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
