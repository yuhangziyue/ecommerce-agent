import { createDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { PgSessionStore } from './pg-session-store.js';
import { PgRefundStore } from './pg-refund-store.js';
import { PgProfileStore } from './pg-profile-store.js';
import { PgUsageStore } from './pg-usage-store.js';
import { PgFlowStore } from './pg-flow-store.js';
import { PgConfirmationStore } from './pg-confirmation-store.js';
import { PgTenantConfigStore } from './pg-tenant-config-store.js';
import { PgApiKeyStore } from './pg-api-key-store.js';
import { PgIdempotencyStore } from './pg-idempotency-store.js';
import { createSessionCache, CachedSessionStore, type SessionCache } from './session-cache.js';
import type {
  Database,
  ProfileStore,
  RefundStore,
  SessionStore,
  UsageStore,
} from './types.js';
import type { ConfirmationStore, FlowStore } from '../flows/types.js';
import type { TenantConfigStore } from '../tenants/config.js';
import type { ApiKeyStore, IdempotencyStore } from '../auth/types.js';

export * from './types.js';
export { createDatabase, PGliteDatabase, PgPoolDatabase } from './database.js';
export { runMigrations, truncateAll } from './migrations.js';
export { PgSessionStore } from './pg-session-store.js';
export { PgRefundStore } from './pg-refund-store.js';
export { PgProfileStore, renderProfileContext } from './pg-profile-store.js';
export { PgUsageStore, ANONYMOUS_TENANT } from './pg-usage-store.js';
export { PgFlowStore } from './pg-flow-store.js';
export { PgConfirmationStore } from './pg-confirmation-store.js';
export { PgTenantConfigStore } from './pg-tenant-config-store.js';
export { PgApiKeyStore } from './pg-api-key-store.js';
export { PgIdempotencyStore } from './pg-idempotency-store.js';
export {
  createSessionCache,
  CachedSessionStore,
  NoOpSessionCache,
  RedisSessionCache,
  type SessionCache,
} from './session-cache.js';

export interface Stores {
  db: Database;
  sessions: SessionStore;
  refunds: RefundStore;
  profiles: ProfileStore;
  /** v0.11 计费账本 */
  usage: UsageStore;
  /** v0.12 业务流与异步确认 */
  flows: FlowStore;
  confirmations: ConfirmationStore;
  /** v0.13 租户配置 */
  tenantConfigs: TenantConfigStore;
  /** v1.1 调用方身份与幂等键 */
  apiKeys: ApiKeyStore;
  idempotency: IdempotencyStore;
  /** v0.7：会话热缓存。Redis 不可用时是 NoOp —— 服务照常工作，只是慢一点 */
  cache: SessionCache;
  close(): Promise<void>;
}

/**
 * 开库 + 跑迁移 + 装配全部 store。应用启动时调一次。
 *
 * `DATABASE_URL` 有值走真实 PostgreSQL，没值走 PGlite（落 `.data/pg`）——
 * **零配置即可跑**，生产切真 PG 只改环境变量，业务代码一行不动。
 */
export async function openStores(
  connectionString?: string,
  redisUrl?: string
): Promise<Stores> {
  const db = await createDatabase(connectionString);
  await runMigrations(db);

  // 缓存连不上会自动降级为 NoOp，不抛错、不阻塞启动
  const cache = await createSessionCache(redisUrl);

  return {
    db,
    sessions: new CachedSessionStore(new PgSessionStore(db), cache),
    refunds: new PgRefundStore(db),
    profiles: new PgProfileStore(db),
    usage: new PgUsageStore(db),
    flows: new PgFlowStore(db),
    confirmations: new PgConfirmationStore(db),
    tenantConfigs: new PgTenantConfigStore(db),
    apiKeys: new PgApiKeyStore(db),
    idempotency: new PgIdempotencyStore(db),
    cache,
    close: async () => {
      await cache.close();
      await db.close();
    },
  };
}
