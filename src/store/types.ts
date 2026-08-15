import type { SessionEntry } from '../core/types.js';

// ============ 引擎抽象 ============

export interface QueryResult<R = Record<string, unknown>> {
  rows: R[];
}

/**
 * 数据库引擎抽象。
 *
 * 两个实现：
 * - `PGliteDatabase` —— PostgreSQL 编译成 WASM，跑在进程内，零基础设施（本地/测试默认）
 * - `PgPoolDatabase` —— `pg` 驱动连真实 PostgreSQL（生产）
 *
 * 刻意**不做**内存 Mock 实现：内存版在唯一约束、事务、NULL 语义上与真 SQL 有差异，
 * 会产生 mock 漂移 —— 测试全绿而生产炸。PGlite 是真 Postgres，测试直接打真 SQL。
 */
export interface Database {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<R>>;
  /** 执行不带参数的多语句 SQL（迁移用） */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  readonly engine: 'pglite' | 'pg';
}

// ============ 会话存储 ============

export interface SessionRecord {
  id: string;
  userId: string | null;
  tenantId: string | null;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}

export interface CreateSessionInput {
  id?: string;
  userId?: string;
  tenantId?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionStore {
  create(input?: CreateSessionInput): Promise<SessionRecord>;
  get(id: string): Promise<SessionRecord | null>;
  /** 按创建时间倒序 */
  listByUser(userId: string, limit?: number): Promise<SessionRecord[]>;
  listByTenant(tenantId: string, limit?: number): Promise<SessionRecord[]>;
  appendEntry(sessionId: string, entry: SessionEntry): Promise<void>;
  /** 按追加顺序（seq）返回，不依赖时间戳 —— 并发写入下时间戳可能相同 */
  getEntries(sessionId: string): Promise<SessionEntry[]>;
}

// ============ 退款工单存储 ============

export interface RefundTicketRecord {
  refundId: string;
  orderId: string;
  amount: number;
  reason: string;
  createdAt: number;
}

export interface RefundStore {
  findByOrderId(orderId: string): Promise<RefundTicketRecord | undefined>;
  /**
   * 已存在则返回原工单（`created: false`），否则创建。
   * PG 实现靠 `UNIQUE(order_id)` + `ON CONFLICT DO NOTHING` 保证真幂等 ——
   * v0.3 的进程内实现重启即失效，多实例下完全无效。
   */
  createIfAbsent(input: {
    orderId: string;
    amount: number;
    reason: string;
  }): Promise<{ ticket: RefundTicketRecord; created: boolean }>;
}

// ============ 用户画像（v0.7 长期记忆） ============

export interface UserProfile {
  /** v1.1：画像的身份是**(租户, 用户)** 而不是用户 —— 见 ProfileStore 的说明 */
  tenantId: string;
  userId: string;
  displayName: string | null;
  /** 结构化偏好：收货时间、称呼、发票抬头等 */
  preferences: Record<string, unknown>;
  /** 自由文本备注：历史投诉、特殊要求 */
  notes: string[];
  updatedAt: number;
}

/**
 * 长期记忆存储。
 *
 * **每个方法的第一个参数都是租户，这是 v1.1 的核心修正。**
 * v0.7~v1.0 期间画像按 `user_id` 单列存储，而 `user_id` 在真实接入中通常是
 * 手机号或会员号 —— 可枚举。任何租户拿一个手机号就能读到另一个租户客户的
 * 称呼、收货偏好、历史投诉备注。
 *
 * 把租户放在**第一个参数**而不是塞进 patch 里，是为了让漏传变成编译错误
 * 而不是运行时的静默串户。
 */
export interface ProfileStore {
  get(tenantId: string, userId: string): Promise<UserProfile | null>;
  /** 局部更新：只覆盖传入的字段，preferences 做浅合并 */
  upsert(
    tenantId: string,
    userId: string,
    patch: { displayName?: string; preferences?: Record<string, unknown> }
  ): Promise<UserProfile>;
  addNote(tenantId: string, userId: string, note: string): Promise<UserProfile>;
}

// ============ 计费账本（v0.11） ============

export interface UsageRecord {
  tenantId: string;
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * 计费口径的 token 数 = 真实 prompt 规模 + 输出。
   *
   * 用这个而不是 input+output：API 的 `input_tokens` 语义是**未命中缓存的剩余部分**，
   * 只看它会让跑在大缓存前缀上的会话严重低估用量（v0.7 已在 TokenTracker 里踩过）。
   */
  billableTokens: number;
  /** 按**调用当时**的价格算好的成本，不在查询时重算 */
  costUsd: number;
  /** 定价窗口来源标记，排查「这条为什么算这么多钱」 */
  pricingResolved?: string;
  at: number;
}

export interface UsageSummary {
  billableTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  callCount: number;
}

export interface UsageStore {
  append(record: UsageRecord): Promise<void>;
  /** `since` 为毫秒时间戳，用于按计费周期聚合 */
  sumByTenant(tenantId: string, since?: number): Promise<UsageSummary>;
  sumBySession(sessionId: string): Promise<UsageSummary>;
  listByTenant(tenantId: string, limit?: number): Promise<UsageRecord[]>;
}
