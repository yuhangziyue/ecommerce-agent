import { createDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { PgSessionStore } from './pg-session-store.js';
import { PgRefundStore } from './pg-refund-store.js';
import type { Database, RefundStore, SessionStore } from './types.js';

export * from './types.js';
export { createDatabase, PGliteDatabase, PgPoolDatabase } from './database.js';
export { runMigrations, truncateAll } from './migrations.js';
export { PgSessionStore } from './pg-session-store.js';
export { PgRefundStore } from './pg-refund-store.js';

export interface Stores {
  db: Database;
  sessions: SessionStore;
  refunds: RefundStore;
  close(): Promise<void>;
}

/**
 * 开库 + 跑迁移 + 装配全部 store。应用启动时调一次。
 *
 * `DATABASE_URL` 有值走真实 PostgreSQL，没值走 PGlite（落 `.data/pg`）——
 * **零配置即可跑**，生产切真 PG 只改环境变量，业务代码一行不动。
 */
export async function openStores(connectionString?: string): Promise<Stores> {
  const db = await createDatabase(connectionString);
  await runMigrations(db);

  return {
    db,
    sessions: new PgSessionStore(db),
    refunds: new PgRefundStore(db),
    close: () => db.close(),
  };
}
