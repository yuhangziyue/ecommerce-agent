import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { AgentLoop } from '../core/agent-loop.js';
import { ModelProvider } from '../core/model-provider.js';
import { EventBus } from '../core/event-bus.js';
import { Session } from '../core/session.js';
import { TokenTracker } from '../core/token-tracker.js';
import { buildDefaultPipeline } from '../middleware/index.js';
import { buildToolRegistry } from '../tools/index.js';
import { setRefundStore } from '../tools/refund-store.js';
import { SYSTEM_PROMPT } from '../prompts/system-prompt.js';
import { ResponseScorer } from '../evaluation/response-scorer.js';
import { SseWriter } from './sse.js';
import { SummaryCompactor } from '../memory/summary-compactor.js';
import { createCompactionMiddleware } from '../middleware/compaction.mw.js';
import { createProfileMiddleware } from '../middleware/profile.mw.js';
import { Pipeline } from '../core/pipeline.js';
import type { Stores } from '../store/index.js';
import type { AgentConfig, AgentEvent, ChatProvider } from '../core/types.js';

export interface AppOptions {
  stores: Stores;
  config: AgentConfig;
  /** 注入假 provider 便于测试；缺省用真实 ModelProvider */
  provider?: ChatProvider;
  logger?: boolean;
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

  const compactor = new SummaryCompactor({
    provider: opts.provider ?? new ModelProvider(config.model, config.apiKey),
    model: config.model,
  });

  /** 在默认管道上挂两个记忆中间件（顺序约束由 buildDefaultPipeline 内部保证） */
  function buildMemoryPipeline(o: {
    tracker: TokenTracker;
    session: Session;
    userId: string | null;
  }): Pipeline {
    return buildDefaultPipeline({
      tracker: o.tracker,
      maxTokens: config.maxTokensPerSession,
      maxMessages: 20,
      preTurn: [createProfileMiddleware({ profiles: stores.profiles, userId: o.userId })],
      beforeTrim: [createCompactionMiddleware({ compactor, session: o.session })],
    });
  }

  /**
   * 每请求装配一个 AgentLoop。**进程内不缓存任何会话** ——
   * 代价是每次读一次库（v0.7 用 Redis 热缓存优化），
   * 收益是天然可水平扩容：任意实例都能接任意请求。
   */
  async function prepareTurn(body: ChatBody): Promise<
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

    const bus = new EventBus();
    const tracker = new TokenTracker();
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
      }),
      scorer: new ResponseScorer(),
      // 服务端没有交互式确认的通道：高风险工具一律拒绝，
      // 由模型改走 human_handoff。真正的异步确认归 v0.12 业务流状态机。
      onConfirm: async () => false,
    });

    return { ok: true, session, loop, bus, tracker };
  }

  // ============ SSE 流式 ============

  app.post<{ Body: ChatBody }>(
    '/v1/chat',
    { schema: { body: CHAT_BODY_SCHEMA } },
    async (request, reply) => {
      const prepared = await prepareTurn(request.body);
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

      const writer = new SseWriter(reply.raw);
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
