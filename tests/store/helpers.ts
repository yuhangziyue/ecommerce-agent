import { PGliteDatabase } from '../../src/store/database.js';
import { runMigrations, truncateAll } from '../../src/store/migrations.js';
import type { Database } from '../../src/store/types.js';
import type { Stores } from '../../src/store/index.js';

/**
 * 每个测试**文件**共享一个 PGlite 实例。
 *
 * 实测创建一个实例要 450–780ms —— 每个用例新建会让测试时长失控。
 * 隔离靠 `beforeEach` 的 TRUNCATE，不靠新建实例。
 */
export async function openTestDb(): Promise<Database> {
  const db = await PGliteDatabase.open(); // 纯内存，不落盘
  await runMigrations(db);
  return db;
}

export { truncateAll };

/**
 * 组装一套完整的测试 Stores（含画像、计费账本与 NoOp 缓存）。
 *
 * 返回类型**显式标注为 `Stores`**：靠推断的话，漏掉一个新 store 时
 * 这里不报错，而是在每个用 buildApp 的用例里炸成 500 —— 报错信息离原因十万八千里。
 */
export async function makeTestStores(db: Database): Promise<Stores> {
  const { PgSessionStore } = await import('../../src/store/pg-session-store.js');
  const { PgRefundStore } = await import('../../src/store/pg-refund-store.js');
  const { PgProfileStore } = await import('../../src/store/pg-profile-store.js');
  const { PgUsageStore } = await import('../../src/store/pg-usage-store.js');
  const { PgFlowStore } = await import('../../src/store/pg-flow-store.js');
  const { PgConfirmationStore } = await import('../../src/store/pg-confirmation-store.js');
  const { PgTenantConfigStore } = await import('../../src/store/pg-tenant-config-store.js');
  const { NoOpSessionCache } = await import('../../src/store/session-cache.js');

  const cache = new NoOpSessionCache();
  return {
    db,
    sessions: new PgSessionStore(db),
    refunds: new PgRefundStore(db),
    profiles: new PgProfileStore(db),
    usage: new PgUsageStore(db),
    flows: new PgFlowStore(db),
    confirmations: new PgConfirmationStore(db),
    tenantConfigs: new PgTenantConfigStore(db),
    cache,
    close: async () => {},
  };
}
