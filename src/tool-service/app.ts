import Fastify, { type FastifyInstance } from 'fastify';
import { buildToolRegistry, setFlowEngine } from '../tools/index.js';
import { setRefundStore } from '../tools/refund-store.js';
import { describe } from '../tools/gateway.js';
import { FlowEngine } from '../flows/engine.js';
import { buildReturnFlow, DEFAULT_RETURN_POLICY } from '../flows/return-flow.js';
import { MetricsRegistry } from '../observability/metrics.js';
import type { Stores } from '../store/index.js';
import { safeEqual, parseBearer } from '../auth/api-key.js';
import type { ToolContext } from '../core/types.js';

/**
 * 工具服务：独立进程，只干一件事 —— 执行工具。
 *
 * 那两个模块级单例（退款 store、流程引擎）**跟着工具走** ——
 * 它们本来就属于工具执行层。这个拆分让它们从「架构污点」
 * 变成「服务内部实现细节」：进程里只有一套工具，全局单例就是对的。
 */
export interface ToolServiceOptions {
  stores: Stores;
  logger?: boolean;
  metrics?: MetricsRegistry;
  /**
   * v1.1 共享密钥。不设则**开放**（内网部署的默认假设），但启动时会警告。
   *
   * 刻意不用主服务那套 API Key：工具服务的调用方只有编排层一个，
   * 没有多租户、没有 scope —— 引入一整套密钥体系是过度设计。
   */
  authToken?: string;
}

export const TOOL_SERVICE_OPEN_WARNING =
  '[tool-service] ⚠️  未设置 TOOL_SERVICE_TOKEN —— 任何能连到本端口的人都可以直接执行退款等高风险工具，且不经过主服务的确认流。仅限可信内网。';

const EXECUTE_SCHEMA = {
  type: 'object',
  required: ['name', 'input'],
  properties: {
    name: { type: 'string' },
    input: { type: 'object' },
    context: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        userId: { type: ['string', 'null'] },
        tenantId: { type: ['string', 'null'] },
        traceId: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;

export async function buildToolService(
  opts: ToolServiceOptions
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    ajv: { customOptions: { removeAdditional: false } },
  });

  // v1.1：主服务的高风险确认流（v0.12）挡在**编排层**。
  // 绕过编排层直接打这个端点，那道确认流根本不存在 ——
  // 所以这里必须有自己的门，哪怕只是一把共享钥匙
  if (!opts.authToken) console.warn(TOOL_SERVICE_OPEN_WARNING);

  app.addHook('onRequest', async (request, reply) => {
    if (!opts.authToken) return;
    if (request.routeOptions?.url === '/healthz' || request.url === '/healthz') return;
    if (request.routeOptions?.url === '/metrics' || request.url === '/metrics') return;

    const presented = parseBearer(request.headers.authorization);
    // 定长比较：凭证比较不做时序防护是不需要每次重新论证的默认动作
    if (!presented || !safeEqual(presented, opts.authToken)) {
      return reply
        .status(401)
        .header('WWW-Authenticate', 'Bearer realm="tool-service"')
        .send({ error: { code: 'unauthorized', message: '凭证无效或缺失' } });
    }
  });

  const registry = buildToolRegistry();
  setRefundStore(opts.stores.refunds);
  setFlowEngine(new FlowEngine(opts.stores.flows, [buildReturnFlow(DEFAULT_RETURN_POLICY)]));

  const metricsRegistry = opts.metrics ?? new MetricsRegistry();
  const execCount = metricsRegistry.counter(
    'tool_service_executions_total',
    '工具执行次数',
    ['tool', 'status']
  );
  const execDuration = metricsRegistry.histogram(
    'tool_service_duration_seconds',
    '工具执行耗时',
    ['tool']
  );

  app.get('/v1/tools', async (_request, reply) =>
    reply.send({ tools: registry.getAll().map(describe) })
  );

  app.post<{
    Body: { name: string; input: Record<string, unknown>; context?: ToolContext };
  }>(
    '/v1/tools/execute',
    { schema: { body: EXECUTE_SCHEMA } },
    async (request, reply) => {
      const { name, input, context } = request.body;
      // trace 头优先于 body —— 网关塞的是头，body 里的是兜底
      const traceId =
        (request.headers['x-trace-id'] as string | undefined) ?? context?.traceId;
      const spanId = request.headers['x-span-id'] as string | undefined;

      const tool = registry.get(name);
      if (!tool) {
        execCount.inc({ tool: name, status: 'not_found' });
        return reply
          .status(404)
          .send({ error: { code: 'tool_not_found', message: `工具 ${name} 不存在` } });
      }

      // **两侧都校验**：编排层校验过不代表这里可以不校验 ——
      // 工具服务是独立的网络端点，任何人都能直接打它
      const validation = registry.validate(name, input);
      if (!validation.ok) {
        execCount.inc({ tool: name, status: 'invalid' });
        return reply.status(400).send({
          error: { code: 'invalid_params', message: validation.error },
        });
      }

      const started = Date.now();
      try {
        const result = await tool.execute(input, {
          sessionId: context?.sessionId ?? '',
          userId: context?.userId ?? null,
          tenantId: context?.tenantId ?? null,
          traceId,
        });
        const durationMs = Date.now() - started;

        execCount.inc({ tool: name, status: result.isError ? 'error' : 'ok' });
        execDuration.observe(durationMs / 1000, { tool: name });

        if (opts.logger) {
          request.log.info({ traceId, spanId, tool: name, durationMs }, '工具执行完成');
        }

        return reply.send({ result, trace_id: traceId ?? null, duration_ms: durationMs });
      } catch (err) {
        execCount.inc({ tool: name, status: 'throw' });
        // 工具抛异常是**工具的问题**，用 200 + isError 返回而不是 5xx ——
        // 5xx 会让调用侧当成「服务不可用」并触发重试，而重试一个必然失败的调用没有意义
        return reply.send({
          result: {
            content: `工具执行出错: ${(err as Error).message}`,
            isError: true,
          },
          trace_id: traceId ?? null,
          duration_ms: Date.now() - started,
        });
      }
    }
  );

  app.get('/metrics', async (_request, reply) =>
    reply
      .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(metricsRegistry.render())
  );

  let draining = false;
  app.decorate('startDraining', () => {
    draining = true;
  });

  app.get('/healthz', async (_request, reply) => {
    if (draining) {
      return reply
        .status(503)
        .send({ status: 'draining', service: 'tool-service' });
    }
    try {
      await opts.stores.db.query('SELECT 1');
      return reply.send({ status: 'ok', service: 'tool-service', tools: registry.getAll().length });
    } catch (err) {
      return reply
        .status(503)
        .send({ status: 'degraded', error: (err as Error).message });
    }
  });

  return app;
}
