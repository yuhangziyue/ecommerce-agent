import type { FastifyInstance } from 'fastify';

export interface ShutdownOptions {
  app: FastifyInstance & { startDraining?: () => void };
  /** 关闭数据库/缓存等资源 */
  closeResources: () => Promise<void>;
  /** 等在途请求的最长时间。**必须有上限** —— 一个卡住的请求不能拖住整个部署 */
  graceMs?: number;
  onLog?: (msg: string) => void;
}

/**
 * 优雅退出。
 *
 * 顺序是刻意的：
 * 1. 先置 draining —— 健康检查转不健康，负载均衡停止派新活
 * 2. 再等一小会儿 —— 给 LB 的健康检查周期留时间感知到
 * 3. 然后 `app.close()` 等在途请求跑完
 * 4. 最后关资源
 *
 * 少了第 2 步，LB 还没反应过来就已经开始拒绝连接了 ——
 * 表现为部署期间零星的 502，而且极难复现。
 */
export function installGracefulShutdown(opts: ShutdownOptions): () => Promise<void> {
  const log = opts.onLog ?? ((m: string) => console.log(m));
  const graceMs = opts.graceMs ?? 15_000;
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    // 连按两次 Ctrl-C 时不该跑两遍关闭流程
    if (shuttingDown) {
      log(`[shutdown] 已在退出中，忽略 ${signal}`);
      return;
    }
    shuttingDown = true;
    log(`[shutdown] 收到 ${signal}，开始优雅退出`);

    opts.app.startDraining?.();
    log('[shutdown] 已置为 draining，健康检查转不健康');
    await new Promise((r) => setTimeout(r, Math.min(2000, graceMs)));

    const timer = setTimeout(() => {
      log(`[shutdown] 超过 ${graceMs}ms 仍有在途请求，强制退出`);
      process.exit(1);
    }, graceMs);
    // 这个定时器不该阻止进程自然退出
    timer.unref?.();

    try {
      await opts.app.close();
      log('[shutdown] 在途请求已完成');
      await opts.closeResources();
      log('[shutdown] 资源已释放，退出');
    } catch (err) {
      log(`[shutdown] 退出过程出错: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void shutdown(signal).then(() => process.exit(0)));
  }

  return () => shutdown('manual');
}
