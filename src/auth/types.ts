/**
 * 调用方身份（v1.1）。
 *
 * 前十五个版本里，「租户」是**请求体里的一个字符串**——
 * 账本、配额、安全规则、售后政策全挂在上面，而它由调用方自己声明。
 * 这一版把它挪到凭证里：`Principal` 是本次请求身份的**唯一来源**，
 * 任何地方要租户号都只能问它。
 */

/**
 * 权限范围。刻意做得很粗——细粒度权限模型需要真实的多方需求来驱动，
 * 凭空设计出来的十几个 scope 只会没人用对。
 *
 * - `chat`  发起对话
 * - `read`  读会话/画像/流程/用量
 * - `write` 决策确认单、改租户配置
 * - `admin` **跨租户**访问（运营后台）。它不包含前三者——一个只做审计的
 *           管理端不该顺手拥有发起对话的能力
 */
export type Scope = 'chat' | 'read' | 'write' | 'admin';

export const ALL_SCOPES: Scope[] = ['chat', 'read', 'write', 'admin'];

export function isScope(x: string): x is Scope {
  return (ALL_SCOPES as string[]).includes(x);
}

export interface Principal {
  keyId: string;
  tenantId: string;
  scopes: Scope[];
  /**
   * 认证被显式关闭（`AGENT_AUTH_DISABLED=1`）时为 true。
   *
   * 存在的理由是**可观测**：出问题时要能一眼看出「这些请求根本没验过身份」，
   * 而不是从环境变量去猜。
   */
  anonymous?: boolean;
}

export interface ApiKeyRecord {
  keyId: string;
  tenantId: string;
  scopes: Scope[];
  label: string | null;
  /** 明文前缀，仅用于人辨认「这是哪把钥匙」。不参与校验 */
  prefix: string;
  revokedAt: number | null;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface ApiKeyStore {
  /**
   * 只按哈希查。**明文永不落库** ——
   * 库被拖走不等于凭证泄露，这是密钥存储的最低要求。
   */
  findByHash(hash: string): Promise<ApiKeyRecord | null>;
  issue(input: {
    tenantId: string;
    scopes: Scope[];
    label?: string;
  }): Promise<{ record: ApiKeyRecord; plaintext: string }>;
  /** 返回 false 表示 key 不存在或已经吊销过 */
  revoke(keyId: string): Promise<boolean>;
  listByTenant(tenantId: string): Promise<ApiKeyRecord[]>;
  /** 记录最近使用时间。失败不该影响请求——它是审计信息不是控制信息 */
  touch(keyId: string, at: number): Promise<void>;
}

// ============ 幂等 ============

export type IdempotencyStatus = 'in_progress' | 'completed';

export interface IdempotencyRecord {
  key: string;
  /** 与 keyId 绑定：两个租户用了同一个 UUID 不该互相命中 */
  keyId: string;
  endpoint: string;
  requestHash: string;
  status: IdempotencyStatus;
  responseStatus: number | null;
  responseBody: unknown;
  createdAt: number;
  expiresAt: number;
}

export interface IdempotencyStore {
  /**
   * 尝试占位。
   *
   * 返回 `{claimed: true}` 表示这是第一次，调用方应当真正执行；
   * 返回 `{claimed: false, existing}` 表示已有记录，由调用方决定重放还是 409。
   * **判断留给调用方**：store 不该知道「请求体不同该报什么码」。
   */
  claim(input: {
    key: string;
    keyId: string;
    endpoint: string;
    requestHash: string;
    ttlMs: number;
    now: number;
  }): Promise<{ claimed: true } | { claimed: false; existing: IdempotencyRecord }>;
  complete(input: {
    key: string;
    keyId: string;
    responseStatus: number;
    responseBody: unknown;
  }): Promise<void>;
  /** 执行失败时释放占位，否则调用方要等到 TTL 才能重试 */
  release(key: string, keyId: string): Promise<void>;
}
