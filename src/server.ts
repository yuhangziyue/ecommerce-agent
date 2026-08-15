import { buildApp } from './server/app.js';
import { openStores } from './store/index.js';
import { SYSTEM_PROMPT } from './prompts/system-prompt.js';
import type { AgentConfig } from './core/types.js';

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
  };

  if (!config.apiKey) {
    console.error('请设置环境变量 ANTHROPIC_API_KEY');
    process.exit(1);
  }

  // stores 在进程启动时开一次，请求间共享 —— 不是每请求开库
  const stores = await openStores(process.env.DATABASE_URL, process.env.REDIS_URL);
  const app = await buildApp({ stores, config, logger: true });

  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n收到 ${signal}，正在优雅退出…`);
    await app.close();
    await stores.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port, host });

  console.log('================================================');
  console.log('  好买电商 AI 客服 · HTTP 服务');
  console.log('================================================');
  console.log(`  监听:     http://${host}:${port}`);
  console.log(`  存储引擎: ${stores.db.engine}${process.env.DATABASE_URL ? '' : '（PGlite，设 DATABASE_URL 可切真实 PG）'}`);
  console.log(`  会话缓存: ${stores.cache.kind}${stores.cache.kind === 'noop' ? '（设 REDIS_URL 可启用；不可用时自动降级）' : ''}`);
  console.log(`  模型:     ${config.model}`);
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
