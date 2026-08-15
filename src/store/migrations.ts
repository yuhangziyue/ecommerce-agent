import type { Database } from './types.js';

interface Migration {
  name: string;
  sql: string;
}

/**
 * 迁移列表，按顺序执行。**只追加，不修改已发布的条目** ——
 * 已经在别的环境跑过的迁移改了内容，那个环境永远不会重跑它。
 */
const MIGRATIONS: Migration[] = [
  {
    name: '001_init',
    sql: `
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  tenant_id  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata   JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- 按用户/租户列会话是 v0.11 多租户计费的基础查询；JSONL 方案下只能遍历全部文件
CREATE INDEX IF NOT EXISTS idx_sessions_user   ON sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON sessions (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS session_entries (
  -- seq 是追加顺序的唯一真相。刻意不用 created_at 排序：
  -- 并发写入下时间戳可能相同，而 v0.3 的投影逻辑对顺序敏感
  --（tool_result 必须跟在产生它的 assistant 消息之后）
  seq        BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  data       JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_entries_session ON session_entries (session_id, seq);

CREATE TABLE IF NOT EXISTS refund_tickets (
  refund_id  TEXT PRIMARY KEY,
  -- 幂等的真实执行者。v0.3 靠进程内 Map，重启即失效、多实例完全无效
  order_id   TEXT NOT NULL UNIQUE,
  amount     NUMERIC(12,2) NOT NULL,
  reason     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`,
  },
  {
    // v0.6 修复 v0.5 遗留的一个真 bug（由 flaky 测试暴露）：
    //
    // sessions 原来按 `created_at DESC, id DESC` 排序。但 PostgreSQL 的 now() 返回
    // **事务开始时间** —— 同一毫秒创建的两个会话 created_at 完全相同，排序退化到
    // id DESC，而 id 的后缀是**随机字符串**，与创建顺序无关 → 顺序随机。
    //
    // 讽刺的是 v0.5 刚为 session_entries 用 BIGSERIAL 解决过同一个问题，
    // 却在 sessions 表上漏了。这里补上同样的单调序列。
    name: '002_sessions_seq',
    sql: `
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS seq BIGSERIAL;

-- 按用户/租户列会话时用 seq 而非 created_at 排序
DROP INDEX IF EXISTS idx_sessions_user;
DROP INDEX IF EXISTS idx_sessions_tenant;
CREATE INDEX IF NOT EXISTS idx_sessions_user_seq   ON sessions (user_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_tenant_seq ON sessions (tenant_id, seq DESC);
`,
  },
  {
    // v0.7 长期记忆：用户画像，跨会话持久化
    name: '003_user_profiles',
    sql: `
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id      TEXT PRIMARY KEY,
  display_name TEXT,
  preferences  JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes        JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
`,
  },
];

/**
 * 执行未跑过的迁移，返回本次实际执行的迁移名。
 * 幂等：重复调用第二次返回空数组。
 */
export async function runMigrations(db: Database): Promise<string[]> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const { rows } = await db.query<{ name: string }>(
    'SELECT name FROM schema_migrations'
  );
  const applied = new Set(rows.map((r) => r.name));

  const executed: string[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    await db.exec(migration.sql);
    await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [
      migration.name,
    ]);
    executed.push(migration.name);
  }

  return executed;
}

/** 清空全部业务表（测试隔离用；不动 schema_migrations，避免每个用例重跑迁移） */
export async function truncateAll(db: Database): Promise<void> {
  await db.exec(
    'TRUNCATE session_entries, sessions, refund_tickets, user_profiles RESTART IDENTITY CASCADE;'
  );
}
