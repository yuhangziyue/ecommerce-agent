import { buildToolService } from './tool-service/app.js';
import { openStores } from './store/index.js';
import { installGracefulShutdown } from './server/shutdown.js';

/**
 * 工具服务入口（`npm run serve:tools`）。
 *
 * v0.15 把工具执行拆成独立进程。与 agent 服务**共享同一个 PostgreSQL** ——
 * 拆的是计算，不是数据：工具要读订单、写退款工单、推流程状态，
 * 再给它一份独立的库只会带来一致性问题。
 */
async function main(): Promise<void> {
  const stores = await openStores(process.env.DATABASE_URL, process.env.REDIS_URL);
  const app = await buildToolService({ stores, logger: true });

  const port = Number(process.env.TOOL_SERVICE_PORT ?? 3101);
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`工具服务已启动: http://localhost:${port}`);

  installGracefulShutdown({
    app,
    closeResources: () => stores.close(),
    graceMs: Number(process.env.SHUTDOWN_GRACE_MS ?? 15_000),
  });
}

main().catch((err) => {
  console.error('工具服务启动失败:', err);
  process.exit(1);
});
