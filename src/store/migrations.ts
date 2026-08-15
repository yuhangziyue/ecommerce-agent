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
  {
    // v0.11 计费账本。
    //
    // 为什么成本要**落库存下来**而不是查询时按当前价格重算：价格会变
    // （v0.3 的 PriceWindow 就是为此存在的），而历史账单不该跟着变。
    // 财务数据的第一原则是可复现 —— 上个月的账今天再查必须是同一个数。
    name: '004_usage_records',
    sql: `
CREATE TABLE IF NOT EXISTS usage_records (
  seq                BIGSERIAL PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  session_id         TEXT NOT NULL,
  model              TEXT NOT NULL,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  -- 计费口径的 token 数（prompt 真实规模 + 输出），配额比对用这一列。
  -- 冗余存储是刻意的：配额检查是热路径，不该每次做四列加法
  billable_tokens    INTEGER NOT NULL DEFAULT 0,
  -- NUMERIC 而非 DOUBLE：钱不能用浮点。20 位整数 + 10 位小数够到 1e10 美元
  cost_usd           NUMERIC(20, 10) NOT NULL DEFAULT 0,
  -- 定价来源标记（v0.3 的 PriceWindow.resolved），排查「这条为什么算这么多」
  pricing_resolved   TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 配额检查的主查询：某租户累计用了多少
CREATE INDEX IF NOT EXISTS idx_usage_tenant     ON usage_records (tenant_id, seq DESC);
-- 会话级配额
CREATE INDEX IF NOT EXISTS idx_usage_session    ON usage_records (session_id, seq DESC);
-- 按时间窗查账（计费周期）
CREATE INDEX IF NOT EXISTS idx_usage_tenant_ts  ON usage_records (tenant_id, created_at DESC);
`,
  },
  {
    // v0.12 多步业务流。
    //
    // 为什么流程状态必须落库而不是留在模型上下文里：v0.7 的滑窗与摘要压缩
    // 会裁剪历史，流程状态跟着一起没了 —— 而且断得悄无声息，
    // 表现为「模型突然忘了正在处理退货」，排查时根本想不到是被裁掉的。
    name: '005_business_flows',
    sql: `
CREATE TABLE IF NOT EXISTS business_flows (
  id           TEXT PRIMARY KEY,
  seq          BIGSERIAL,
  kind         TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  -- 业务主键（订单号）。一个订单同时只应有一条活跃流程 —— 靠部分唯一索引保证
  subject_id   TEXT NOT NULL,
  state        TEXT NOT NULL,
  data         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 每一次流转都留痕：出了纠纷要能回放「谁、何时、从哪到哪、凭什么」
CREATE TABLE IF NOT EXISTS flow_transitions (
  seq         BIGSERIAL PRIMARY KEY,
  flow_id     TEXT NOT NULL REFERENCES business_flows(id) ON DELETE CASCADE,
  from_state  TEXT NOT NULL,
  to_state    TEXT NOT NULL,
  event       TEXT NOT NULL,
  actor       TEXT NOT NULL,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flows_session ON business_flows (session_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_flows_subject ON business_flows (subject_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_transitions_flow ON flow_transitions (flow_id, seq);
`,
  },
  {
    // v0.12 异步确认。
    //
    // v0.6 给服务端写死 `onConfirm: () => false`，高风险工具一律拒绝，
    // 且把拒绝理由伪装成「用户取消了该操作」—— 用户从没取消过任何东西，
    // 排查的人会去查用户行为，而那里什么都没有。这张表让确认变成一次真实往返。
    name: '006_confirmations',
    sql: `
CREATE TABLE IF NOT EXISTS confirmations (
  id          TEXT PRIMARY KEY,
  seq         BIGSERIAL,
  session_id  TEXT NOT NULL,
  tool_name   TEXT NOT NULL,
  tool_input  JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary     TEXT NOT NULL,
  -- pending / approved / rejected / consumed
  -- consumed 是终态：确认单一次性消费，否则一张批准过的单能被重放成多次退款
  status      TEXT NOT NULL DEFAULT 'pending',
  decided_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at  TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_confirmations_session ON confirmations (session_id, seq DESC);
`,
  },
  {
    // v0.13 租户配置。还 v0.10（按租户配安全规则）与 v0.12（按租户配售后政策）的账。
    //
    // 安全规则存的是**追加项**而非全量：租户只能加严不能放宽，
    // 存全量就等于允许替换，一个配置失误能把全局注入防护整个关掉。
    name: '007_tenant_configs',
    sql: `
CREATE TABLE IF NOT EXISTS tenant_configs (
  tenant_id          TEXT PRIMARY KEY,
  extra_safety_rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  return_policy      JSONB NOT NULL DEFAULT '{}'::jsonb,
  quota_limits       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
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

/**
 * 清空全部业务表（测试隔离用；不动 schema_migrations，避免每个用例重跑迁移）。
 *
 * 表名**从系统目录查**而不是写死。写死的版本在 v0.11 咬了一口：
 * 新加 `usage_records` 忘了加进列表 → 数据在用例之间串，8 个用例莫名转红，
 * 而报错信息（「期望 500 得到 3500」）完全指向错误的方向。
 * 这类清单只要靠人记就一定会漏。
 */
export async function truncateAll(db: Database): Promise<void> {
  const { rows } = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`
  );
  if (rows.length === 0) return;

  const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
  await db.exec(`TRUNCATE ${tables} RESTART IDENTITY CASCADE;`);
}
