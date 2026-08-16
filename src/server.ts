import { buildApp } from './server/app.js';
import { openStores } from './store/index.js';
import { SYSTEM_PROMPT } from './prompts/system-prompt.js';
import type { AgentConfig } from './core/types.js';
import { parseSafetyLag } from './server/config.js';
import { installGracefulShutdown } from './server/shutdown.js';
import { RemoteToolGateway, FetchTransport } from './tools/remote-gateway.js';
import { AUTH_DISABLED_WARNING } from './server/auth.js';
import {
  MemorySpanExporter,
  MultiSpanExporter,
  OtlpHttpExporter,
  Tracer,
} from './observability/tracing.js';

/**
 * HTTP 服务入口（`npm run serve`）。
 *
 * v0.6 起这是**对外提供能力的正式形态**。CLI（`npm start`）降级为它的瘦客户端。
 */
async function main(): Promise<void> {
  const config: AgentConfig = {
    model: process.env.AGENT_MODEL || 'claude-opus-5',
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxTurns: 10,
    maxTokensPerSession: 100_000,
    systemPrompt: SYSTEM_PROMPT,
    // 服务端没有交互式确认通道 —— 高风险工具一律拒绝，由模型改走 human_handoff
    confirmHighRisk: true,
    // 面向消费者的客服场景，跨块的 PII 泄露风险高于那几十毫秒首字延迟
    safetyLag: parseSafetyLag(process.env.AGENT_SAFETY_LAG),
  };

  if (!config.apiKey) {
    console.error('请设置环境变量 ANTHROPIC_API_KEY');
    process.exit(1);
  }

  // stores 在进程启动时开一次，请求间共享 —— 不是每请求开库
  const stores = await openStores(process.env.DATABASE_URL, process.env.REDIS_URL);

  // v1.0：设了 TOOL_SERVICE_URL 就把工具执行交给独立的 tool-service，
  // 不设则单进程运行（行为与 v0.14 完全一致）
  // v1.1：认证**默认开启**。关掉必须显式设环境变量，而且要吵得让人看见 ——
  // 一个悄悄关着认证的生产实例，比一个明显没做认证的服务危险得多
  const authDisabled = process.env.AGENT_AUTH_DISABLED === '1';
  if (authDisabled) console.warn(AUTH_DISABLED_WARNING);

  const rateLimitRps = Number(process.env.AGENT_RATE_LIMIT_RPS ?? 20);

  // v1.2 追踪：内存缓冲总是有（让 /v1/traces 在没有 collector 时也能用），
  // 设了 OTLP 端点就再加一路导出。两路互不影响 —— collector 挂了本地照样能看
  const otlpEndpoint = process.env.AGENT_OTLP_ENDPOINT;
  const spanBuffer = new MemorySpanExporter(
    Number(process.env.AGENT_TRACE_BUFFER ?? 2000)
  );
  const tracer = new Tracer({
    exporter: otlpEndpoint
      ? new MultiSpanExporter([spanBuffer, new OtlpHttpExporter(otlpEndpoint)])
      : spanBuffer,
  });

  const toolServiceUrl = process.env.TOOL_SERVICE_URL;
  const app = await buildApp({
    stores,
    config,
    logger: true,
    auth: { disabled: authDisabled },
    tracer,
    spanBuffer,
    turnLockTtlMs: Number(process.env.AGENT_TURN_LOCK_TTL_MS ?? 60_000),
    sweepIntervalMs: Number(process.env.AGENT_SWEEP_INTERVAL_MS ?? 600_000),
    rateLimit: {
      rps: rateLimitRps,
      redisUrl: process.env.REDIS_URL,
      enabled: rateLimitRps > 0,
    },
    toolGateway: toolServiceUrl
      ? new RemoteToolGateway(
          new FetchTransport(
            toolServiceUrl,
            Number(process.env.TOOL_TIMEOUT_MS ?? 10_000),
            process.env.TOOL_SERVICE_TOKEN
          )
        )
      : undefined,
  });

  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';

  installGracefulShutdown({
    app,
    closeResources: () => stores.close(),
    graceMs: Number(process.env.SHUTDOWN_GRACE_MS ?? 15_000),
  });

  await app.listen({ port, host });

  console.log('================================================');
  console.log('  好买电商 AI 客服 · HTTP 服务');
  console.log('================================================');
  console.log(`  监听:     http://${host}:${port}`);
  console.log(`  存储引擎: ${stores.db.engine}${process.env.DATABASE_URL ? '' : '（PGlite，设 DATABASE_URL 可切真实 PG）'}`);
  console.log(`  会话缓存: ${stores.cache.kind}${stores.cache.kind === 'noop' ? '（设 REDIS_URL 可启用；不可用时自动降级）' : ''}`);
  console.log(`  模型:     ${config.model}`);
  console.log(
    `  工具执行: ${toolServiceUrl ? `远程 ${toolServiceUrl}（熔断+重试已启用）` : '本进程（设 TOOL_SERVICE_URL 可拆分）'}`
  );
  console.log(
    `  认证:     ${authDisabled ? '⚠️  已关闭（AGENT_AUTH_DISABLED=1）' : '已启用（Bearer API Key）'}`
  );
  console.log(
    `  追踪:     ${tracer.exporterKind}${otlpEndpoint ? `（OTLP → ${otlpEndpoint}）` : '（内存，设 AGENT_OTLP_ENDPOINT 可接 collector）'}`
  );
  console.log(
    `  限流:     ${rateLimitRps > 0 ? `${rateLimitRps} rps/凭证${process.env.REDIS_URL ? '（Redis 全局）' : '（进程内 —— 多实例下是 N 倍）'}` : '未启用'}`
  );
  console.log('');
  console.log('  POST /v1/chat            → SSE 流式');
  console.log('  POST /v1/chat/sync       → JSON 一次性');
  console.log('  GET  /v1/sessions/:id    → 会话元信息');
  console.log('  GET  /v1/sessions/:id/messages');
  console.log('  GET  /v1/users/:id/profile');
  console.log('  POST /v1/confirmations/:id');
  console.log('  GET  /v1/traces/:trace_id → 本实例链路');
  console.log('  GET  /healthz  ·  GET /metrics   → 免认证');
  console.log('');
  console.log('  签发凭证: npm run key:issue -- --tenant <租户号> --scopes chat,read');
  console.log('================================================\n');
}

main().catch((err) => {
  console.error('服务启动失败:', err);
  process.exit(1);
});
