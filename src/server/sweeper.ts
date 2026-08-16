import type { IdempotencyStore } from '../auth/types.js';

export interface SweeperOptions {
  store: IdempotencyStore;
  /** 触发周期。0 或负数表示不启动 */
  intervalMs: number;
  /** 单次最多删多少条 */
  batchSize?: number;
  now?: () => number;
  onSwept?: (deleted: number) => void;
}

export interface Sweeper {
  /** 手工跑一次（测试用；也可供运维接一个管理命令） */
  runOnce(): Promise<number>;
  stop(): void;
  readonly running: boolean;
}

/**
 * 过期幂等记录的清理（v1.2 · D-6）。
 *
 * **刻意不做成「请求路径上顺手删几条」。** 那看着省事，代价是把不确定的删除耗时
 * 加到每个请求上，而且删除量与流量成正比 —— **流量高峰恰恰是最不该做清理的时候**。
 *
 * 单次有上限：一次 `DELETE` 扫全表会长时间持锁，而这张表同时是幂等占位的热点表。
 * 宁可多跑几轮。
 */
export function startSweeper(opts: SweeperOptions): Sweeper {
  const batchSize = opts.batchSize ?? 500;
  const now = opts.now ?? Date.now;
  let timer: NodeJS.Timeout | null = null;

  const runOnce = async (): Promise<number> => {
    try {
      const deleted = await opts.store.purgeExpired(now(), batchSize);
      if (deleted > 0) opts.onSwept?.(deleted);
      return deleted;
    } catch (err) {
      // 清理失败不该影响服务 —— 它是维护动作，不是业务动作
      console.warn(`[sweeper] 清理失败，下个周期再试：${(err as Error).message}`);
      return 0;
    }
  };

  if (opts.intervalMs > 0) {
    timer = setInterval(() => void runOnce(), opts.intervalMs);
    // **不阻止进程退出**：一个后台维护任务不该让 SIGTERM 之后的进程挂着不走
    timer.unref();
  }

  return {
    runOnce,
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    get running() {
      return timer !== null;
    },
  };
}
