import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { PgApiKeyStore } from '../../src/store/pg-api-key-store.js';
import type { Scope } from '../../src/auth/types.js';
import type { Stores } from '../../src/store/index.js';
import type { Database } from '../../src/store/types.js';

/**
 * v1.1 测试基建。
 *
 * **刻意不给 `buildApp` 加"测试模式绕过认证"** —— 那样测的就不是生产路径了。
 * 每个用例签一把真钥匙，走完整的 Bearer 认证链路。
 */

export interface TestKey {
  plaintext: string;
  keyId: string;
  tenantId: string;
  headers: { authorization: string };
}

export async function seedKey(
  stores: Stores,
  input: { tenantId: string; scopes?: Scope[]; label?: string }
): Promise<TestKey> {
  const { record, plaintext } = await stores.apiKeys.issue({
    tenantId: input.tenantId,
    scopes: input.scopes ?? ['chat', 'read', 'write'],
    label: input.label,
  });
  return {
    plaintext,
    keyId: record.keyId,
    tenantId: record.tenantId,
    headers: { authorization: `Bearer ${plaintext}` },
  };
}

/**
 * 只有 `Database` 时用这个签钥匙。
 *
 * 有些既有用例在 `it` 里现装 `stores`，但它们**共享同一个 db** ——
 * 而凭证在 `api_keys` 表里，对同一个库上的所有 app 实例都可见。
 */
export async function seedKeyOn(
  db: Database,
  input: { tenantId: string; scopes?: Scope[]; label?: string }
): Promise<TestKey> {
  const keys = new PgApiKeyStore(db, 'test');
  const { record, plaintext } = await keys.issue({
    tenantId: input.tenantId,
    scopes: input.scopes ?? ['chat', 'read', 'write'],
    label: input.label,
  });
  return {
    plaintext,
    keyId: record.keyId,
    tenantId: record.tenantId,
    headers: { authorization: `Bearer ${plaintext}` },
  };
}

export interface TestClient {
  inject(opts: InjectOptions): Promise<LightMyRequestResponse>;
}

/**
 * 带凭证的 inject 包装器。
 *
 * 用例里把 `app.inject(...)` 换成 `client.inject(...)` 即可 ——
 * 单条用例仍可用 `headers` 覆盖（测 401 时传空头）。
 *
 * 第二个参数接受 **getter**，因为各文件的 `beforeEach` 会 `truncateAll`
 * 把 `api_keys` 一起清掉 —— 钥匙必须每个用例重新签，而 client 只想装配一次。
 */
export function clientFor(
  app: FastifyInstance,
  key: TestKey | (() => TestKey)
): TestClient {
  const read = typeof key === 'function' ? key : () => key;
  return {
    inject: (opts: InjectOptions) =>
      app.inject({
        ...opts,
        headers: { ...read().headers, ...(opts.headers as object) },
      }),
  };
}
