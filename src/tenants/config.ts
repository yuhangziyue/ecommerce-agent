import type { SafetyRule } from '../safety/rules.js';
import type { ReturnPolicy } from '../flows/return-flow.js';
import type { QuotaLimits } from '../billing/quota.js';

/**
 * 租户级配置（v0.13，还 v0.10 与 v0.12 欠的账）。
 *
 * 多租户在 v0.11 就建立了（账本与配额都按租户隔离），但**配置维度一直没跟上** ——
 * 安全规则是全局一套、售后政策是 `buildApp` 级的，多租户下只能取一个。
 */
export interface TenantConfig {
  tenantId: string;
  /**
   * 租户**追加**的安全规则。刻意叫 `extraSafetyRules` 而不是 `safetyRules` ——
   * 命名本身就说明它是叠加不是替换。见 `resolveSafetyRules` 的说明。
   */
  extraSafetyRules?: { input?: SafetyRule[]; output?: SafetyRule[] };
  returnPolicy?: Partial<ReturnPolicy>;
  quotaLimits?: Partial<QuotaLimits>;
  updatedAt: number;
}

export interface TenantConfigStore {
  get(tenantId: string): Promise<TenantConfig | null>;
  upsert(config: Omit<TenantConfig, 'updatedAt'>): Promise<TenantConfig>;
  list(limit?: number): Promise<TenantConfig[]>;
}

/**
 * 合并租户规则与全局规则。
 *
 * **只能加严，不能放宽。** 这是本函数唯一重要的性质：
 * 全局规则全部保留，租户规则追加在后面。如果允许「替换」，
 * 一个租户的配置失误就能把全局的提示词注入防护整个关掉 ——
 * 而那种事故不会有任何报错，只会在被攻击之后才被发现。
 *
 * 租户规则里出现与全局同 id 的规则时，**忽略租户那条**而不是覆盖：
 * 同 id 覆盖等价于允许放宽（把 block 改成 mask 就绕过去了）。
 */
export function resolveSafetyRules(
  globalRules: SafetyRule[],
  tenantRules: SafetyRule[] = []
): SafetyRule[] {
  const globalIds = new Set(globalRules.map((r) => r.id));
  const additions = tenantRules.filter((r) => {
    if (globalIds.has(r.id)) {
      console.warn(
        `[tenant] 规则 ${r.id} 与全局规则同名，已忽略租户版本 —— 租户只能加严不能覆盖`
      );
      return false;
    }
    return true;
  });
  return [...globalRules, ...additions];
}

/** 合并租户政策与默认政策。租户没配的字段沿用默认值。 */
export function resolveReturnPolicy(
  base: ReturnPolicy,
  override?: Partial<ReturnPolicy>
): ReturnPolicy {
  return { ...base, ...(override ?? {}) };
}

export function resolveQuotaLimits(
  base: QuotaLimits,
  override?: Partial<QuotaLimits>
): QuotaLimits {
  return { ...base, ...(override ?? {}) };
}

/**
 * 带进程内缓存的配置读取。
 *
 * 配置是**读多写极少**的数据，每请求查一次库是纯浪费。
 * 缓存无 TTL、只在写入时显式失效 —— TTL 会让「改了配置要等 5 分钟生效」
 * 变成一个需要向运营解释的行为。
 */
export class CachedTenantConfig {
  private readonly cache = new Map<string, TenantConfig | null>();

  constructor(private readonly store: TenantConfigStore) {}

  async get(tenantId: string | null | undefined): Promise<TenantConfig | null> {
    if (!tenantId) return null;
    if (this.cache.has(tenantId)) return this.cache.get(tenantId)!;

    const config = await this.store.get(tenantId);
    this.cache.set(tenantId, config);
    return config;
  }

  async upsert(config: Omit<TenantConfig, 'updatedAt'>): Promise<TenantConfig> {
    const saved = await this.store.upsert(config);
    this.cache.set(config.tenantId, saved);
    return saved;
  }

  invalidate(tenantId?: string): void {
    if (tenantId) this.cache.delete(tenantId);
    else this.cache.clear();
  }

  get cachedCount(): number {
    return this.cache.size;
  }
}
