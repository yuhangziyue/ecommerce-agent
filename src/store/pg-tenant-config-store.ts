import type { Database } from './types.js';
import type { TenantConfig, TenantConfigStore } from '../tenants/config.js';
import type { SafetyRule } from '../safety/rules.js';

/**
 * 正则不能直接进 JSONB —— `JSON.stringify(/x/)` 得到的是 `{}`，
 * 规则会**静默变成空对象**，读回来后所有租户规则一条都不生效，且毫无报错。
 * 所以存的是 source + flags，读时重建。
 */
interface StoredRule extends Omit<SafetyRule, 'pattern'> {
  pattern: { source: string; flags: string };
}

const toStored = (r: SafetyRule): StoredRule => ({
  ...r,
  pattern: { source: r.pattern.source, flags: r.pattern.flags },
});

const fromStored = (r: StoredRule): SafetyRule => ({
  ...r,
  pattern: new RegExp(r.pattern.source, r.pattern.flags),
});

function toConfig(row: Record<string, any>): TenantConfig {
  const extra = row.extra_safety_rules ?? {};
  return {
    tenantId: row.tenant_id,
    extraSafetyRules: {
      input: (extra.input ?? []).map(fromStored),
      output: (extra.output ?? []).map(fromStored),
    },
    returnPolicy: row.return_policy ?? {},
    quotaLimits: row.quota_limits ?? {},
    updatedAt: Math.round(Number(row.updated_ms)),
  };
}

const SELECT = `
  SELECT tenant_id, extra_safety_rules, return_policy, quota_limits,
         EXTRACT(EPOCH FROM updated_at) * 1000 AS updated_ms
    FROM tenant_configs`;

export class PgTenantConfigStore implements TenantConfigStore {
  constructor(private readonly db: Database) {}

  async get(tenantId: string): Promise<TenantConfig | null> {
    const { rows } = await this.db.query<Record<string, any>>(
      `${SELECT} WHERE tenant_id = $1`,
      [tenantId]
    );
    return rows[0] ? toConfig(rows[0]) : null;
  }

  async upsert(config: Omit<TenantConfig, 'updatedAt'>): Promise<TenantConfig> {
    const extra = {
      input: (config.extraSafetyRules?.input ?? []).map(toStored),
      output: (config.extraSafetyRules?.output ?? []).map(toStored),
    };

    const { rows } = await this.db.query<Record<string, any>>(
      `INSERT INTO tenant_configs (tenant_id, extra_safety_rules, return_policy, quota_limits)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id) DO UPDATE
         SET extra_safety_rules = EXCLUDED.extra_safety_rules,
             return_policy      = EXCLUDED.return_policy,
             quota_limits       = EXCLUDED.quota_limits,
             updated_at         = now()
       RETURNING tenant_id, extra_safety_rules, return_policy, quota_limits,
                 EXTRACT(EPOCH FROM updated_at) * 1000 AS updated_ms`,
      [
        config.tenantId,
        JSON.stringify(extra),
        JSON.stringify(config.returnPolicy ?? {}),
        JSON.stringify(config.quotaLimits ?? {}),
      ]
    );
    return toConfig(rows[0]);
  }

  async list(limit = 50): Promise<TenantConfig[]> {
    const { rows } = await this.db.query<Record<string, any>>(
      `${SELECT} ORDER BY tenant_id LIMIT $1`,
      [limit]
    );
    return rows.map(toConfig);
  }
}
