import type { Database, UsageRecord, UsageStore, UsageSummary } from './types.js';

/** 无租户的调用挂到这个桶上 —— 不能丢账，也不能挂到别人头上 */
export const ANONYMOUS_TENANT = 'anonymous';

export class PgUsageStore implements UsageStore {
  constructor(private readonly db: Database) {}

  async append(record: UsageRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO usage_records
         (tenant_id, session_id, model,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          billable_tokens, cost_usd, pricing_resolved, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, to_timestamp($11::double precision / 1000))`,
      [
        record.tenantId || ANONYMOUS_TENANT,
        record.sessionId,
        record.model,
        record.inputTokens,
        record.outputTokens,
        record.cacheReadTokens,
        record.cacheWriteTokens,
        record.billableTokens,
        // 成本以字符串入库：JS number 转 NUMERIC 会经过浮点，
        // 而 toFixed(10) 保住了 NUMERIC(20,10) 的全部精度
        record.costUsd.toFixed(10),
        record.pricingResolved ?? null,
        record.at,
      ]
    );
  }

  async sumByTenant(tenantId: string, since?: number): Promise<UsageSummary> {
    return this.sum('tenant_id', tenantId, since);
  }

  async sumBySession(sessionId: string): Promise<UsageSummary> {
    return this.sum('session_id', sessionId);
  }

  /**
   * `column` 只可能是本类内部传入的两个字面量，不来自外部输入 ——
   * 但仍然白名单校验，因为「以后有人加个第三种维度」是必然发生的事。
   */
  private async sum(
    column: 'tenant_id' | 'session_id',
    value: string,
    since?: number
  ): Promise<UsageSummary> {
    if (column !== 'tenant_id' && column !== 'session_id') {
      throw new Error(`非法的聚合维度: ${column}`);
    }

    const params: unknown[] = [value];
    let where = `${column} = $1`;
    if (since !== undefined) {
      params.push(since);
      where += ` AND created_at >= to_timestamp($2::double precision / 1000)`;
    }

    const { rows } = await this.db.query<{
      billable: string | null;
      input: string | null;
      output: string | null;
      cache_read: string | null;
      cache_write: string | null;
      cost: string | null;
      calls: string;
    }>(
      `SELECT COALESCE(SUM(billable_tokens),0)    AS billable,
              COALESCE(SUM(input_tokens),0)       AS input,
              COALESCE(SUM(output_tokens),0)      AS output,
              COALESCE(SUM(cache_read_tokens),0)  AS cache_read,
              COALESCE(SUM(cache_write_tokens),0) AS cache_write,
              COALESCE(SUM(cost_usd),0)           AS cost,
              COUNT(*)                            AS calls
         FROM usage_records
        WHERE ${where}`,
      params
    );

    const r = rows[0];
    return {
      // PG 的 SUM 返回字符串（bigint/numeric 超出 JS number 安全范围的保护）
      billableTokens: Number(r?.billable ?? 0),
      inputTokens: Number(r?.input ?? 0),
      outputTokens: Number(r?.output ?? 0),
      cacheReadTokens: Number(r?.cache_read ?? 0),
      cacheWriteTokens: Number(r?.cache_write ?? 0),
      costUsd: Number(r?.cost ?? 0),
      callCount: Number(r?.calls ?? 0),
    };
  }

  async listByTenant(tenantId: string, limit = 50): Promise<UsageRecord[]> {
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT tenant_id, session_id, model,
              input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
              billable_tokens, cost_usd, pricing_resolved,
              EXTRACT(EPOCH FROM created_at) * 1000 AS at_ms
         FROM usage_records
        WHERE tenant_id = $1
        ORDER BY seq DESC
        LIMIT $2`,
      [tenantId, limit]
    );

    return rows.map((r) => ({
      tenantId: r.tenant_id,
      sessionId: r.session_id,
      model: r.model,
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      cacheReadTokens: Number(r.cache_read_tokens),
      cacheWriteTokens: Number(r.cache_write_tokens),
      billableTokens: Number(r.billable_tokens),
      costUsd: Number(r.cost_usd),
      pricingResolved: r.pricing_resolved ?? undefined,
      at: Math.round(Number(r.at_ms)),
    }));
  }
}
