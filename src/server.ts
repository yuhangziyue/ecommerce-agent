import { buildApp } from './server/app.js';
import { openStores } from './store/index.js';
import { SYSTEM_PROMPT } from './prompts/system-prompt.js';
import type { AgentConfig } from './core/types.js';
import { parseSafetyLag } from './server/config.js';
import { installGracefulShutdown } from './server/shutdown.js';
import { RemoteToolGateway, FetchTransport } from './tools/remote-gateway.js';

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
  const toolServiceUrl = process.env.TOOL_SERVICE_URL;
  const app = await buildApp({
    stores,
    config,
    logger: true,
    toolGateway: toolServiceUrl
      ? new RemoteToolGateway(
          new FetchTransport(toolServiceUrl, Number(process.env.TOOL_TIMEOUT_MS ?? 10_000))
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
  console.log('');
  console.log('  POST /v1/chat            → SSE 流式');
  console.log('  POST /v1/chat/sync       → JSON 一次性');
  console.log('  GET  /v1/sessions/:id    → 会话元信息');
  console.log('  GET  /v1/sessions/:id/messages');
  console.log('  GET  /v1/users/:id/profile');
  console.log('  GET  /healthz');
  console.log('================================================\n');
}

main().catch((err) => {
  console.error('服务启动失败:', err);
  process.exit(1);
});
