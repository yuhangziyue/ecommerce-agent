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
  {
    // v1.1 API Key。
    //
    // **存哈希不存明文**：库被拖走 ≠ 凭证泄露。明文只在签发那一刻出现一次，
    // 之后系统里任何地方都再也拿不到它 —— 包括我们自己。
    // 客户丢了钥匙只能重新签发，这是正确的行为而不是缺陷。
    name: '008_api_keys',
    sql: `
CREATE TABLE IF NOT EXISTS api_keys (
  key_id       TEXT PRIMARY KEY,
  -- 唯一索引在哈希上：认证路径是「拿哈希查一行」，必须走索引。
  -- 全表扫描做认证意味着 key 越多登录越慢，而 key 只会越来越多
  key_hash     TEXT NOT NULL UNIQUE,
  tenant_id    TEXT NOT NULL,
  scopes       JSONB NOT NULL DEFAULT '[]'::jsonb,
  label        TEXT,
  -- 明文前缀，仅供人辨认「后台列表里这是哪把钥匙」。不参与校验
  prefix       TEXT NOT NULL,
  revoked_at   TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys (tenant_id, created_at DESC);
`,
  },
  {
    // v1.1 幂等键。
    //
    // 前面三个版本都在防重复执行（v0.3 退款库级幂等、v0.12 确认单一次性消费、
    // v1.0 高风险工具不重试），但**入口层完全敞着** —— 调用方一次超时重发，
    // 那是一个全新的请求、全新的 tool_use_id、全新的确认单，三道防线一道都不生效。
    name: '009_idempotency_keys',
    sql: `
CREATE TABLE IF NOT EXISTS idempotency_keys (
  -- 复合主键：两个租户各自用了同一个 UUID 不该互相命中。
  -- 只用 key 做主键会让 A 的重放命中 B 的响应 —— 那是跨租户数据泄露
  key             TEXT NOT NULL,
  key_id          TEXT NOT NULL,
  endpoint        TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  status          TEXT NOT NULL,
  response_status INTEGER,
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 占位后进程崩溃时的兜底：过期即视为未占位。
  -- 刻意不做分布式锁 —— 冲突窗口只有单次请求时长，代价不值得
  expires_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (key, key_id)
);
CREATE INDEX IF NOT EXISTS idx_idem_expiry ON idempotency_keys (expires_at);
`,
  },
  {
    // v1.1 画像补租户维度。
    //
    // 原主键是 user_id **单列** —— 画像根本没有租户维度。而 user_id 在真实接入中
    // 通常是手机号或会员号，**可枚举**：租户 B 拿同一个 user_id 就能读到
    // 租户 A 客户的称呼、收货偏好、历史投诉备注，全是 PII。
    //
    // 这不是「忘了加校验」，是数据模型缺一维，只能靠迁移修。
    // 存量行归入 'anonymous'（与 usage_records 同一个常量）：
    // 它们本来就没有租户归属，假装知道它们属于谁是伪造数据。
    name: '010_profiles_tenant',
    sql: `
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'anonymous';
ALTER TABLE user_profiles DROP CONSTRAINT IF EXISTS user_profiles_pkey;
ALTER TABLE user_profiles ADD PRIMARY KEY (tenant_id, user_id);
`,
  },
  {
    // v1.2 会话独占锁。
    //
    // 会话是**追加式**的，所以并发不会覆盖数据 —— 它造成的是更隐蔽的问题：
    // 两个请求各自 restore 一份快照、各自往同一条会话追加，
    // 消息顺序交错，`tool_use` 与产生它的 `tool_result` 被别的消息隔开。
    // 而 v0.3 的投影逻辑对顺序敏感 —— 下一轮 restore 出来的历史直接是坏的。
    //
    // 存到期时间而不是布尔量：进程崩了不会把会话永久钉死
    //（与 v1.1 幂等占位同一个模式）。
    name: '011_session_turn_lock',
    sql: `
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS turn_locked_until TIMESTAMPTZ;
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
  // `api_keys` 与 `schema_migrations` 一样被排除：它们是**夹具不是业务数据**。
  // 每个用例都清掉凭证，意味着每个 beforeEach 都要重新签一把钥匙 ——
  // 而绝大多数用例测的根本不是认证。测认证的那两个文件自己管理凭证。
  const { rows } = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename NOT IN ('schema_migrations', 'api_keys')`
  );
  if (rows.length === 0) return;

  const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
  await db.exec(`TRUNCATE ${tables} RESTART IDENTITY CASCADE;`);
}
