import type { Database, QueryResult } from './types.js';

/**
 * PGlite 引擎：PostgreSQL 18.3 编译成 WASM，跑在 Node 进程内。
 *
 * 用途：本地开发与全部测试。零基础设施 —— 不需要 Docker、不需要装 psql。
 * 因为它是**真的 Postgres**，测试里的 UNIQUE 约束、ON CONFLICT、事务、JSONB
 * 行为与生产的真实 PG 一致，不存在 mock 漂移。
 *
 * @param dataDir 省略则纯内存（测试用）；给路径则落盘（本地开发用，默认 `.data/pg`）
 */
export class PGliteDatabase implements Database {
  readonly engine = 'pglite' as const;

  private constructor(private readonly db: any) {}

  static async open(dataDir?: string): Promise<PGliteDatabase> {
    const { PGlite } = await import('@electric-sql/pglite');
    const db = dataDir ? await PGlite.create(dataDir) : await PGlite.create();
    return new PGliteDatabase(db);
  }

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
  ): Promise<QueryResult<R>> {
    const result = await this.db.query(sql, params);
    return { rows: result.rows as R[] };
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

/**
 * 真实 PostgreSQL 引擎（`pg` 驱动 + 连接池）。
 *
 * 生产路径。`pg` 只在这里被 import —— 本地开发与测试不加载它。
 */
export class PgPoolDatabase implements Database {
  readonly engine = 'pg' as const;

  private constructor(private readonly pool: any) {}

  static async open(connectionString: string): Promise<PgPoolDatabase> {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString });
    // 立刻验证连通性 —— 连不上要在启动时炸，不要等第一个请求
    const client = await pool.connect();
    client.release();
    return new PgPoolDatabase(pool);
  }

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
  ): Promise<QueryResult<R>> {
    const result = await this.pool.query(sql, params);
    return { rows: result.rows as R[] };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * 按连接串选引擎。
 *
 * - 给了 `postgres://` / `postgresql://` → 真实 PG
 * - 没给 → PGlite（默认落 `.data/pg`，传 `':memory:'` 则纯内存）
 *
 * 生产切真 PG **只改环境变量**，业务代码一行不动。
 */
export async function createDatabase(connectionString?: string): Promise<Database> {
  if (connectionString && /^postgres(ql)?:\/\//.test(connectionString)) {
    return PgPoolDatabase.open(connectionString);
  }
  if (connectionString === ':memory:') {
    return PGliteDatabase.open();
  }
  return PGliteDatabase.open(connectionString ?? '.data/pg');
}
