import type { Database, RefundStore, RefundTicketRecord } from './types.js';

interface TicketRow {
  refund_id: string;
  order_id: string;
  amount: string | number;
  reason: string;
  created_at: string | Date;
}

function toRecord(row: TicketRow): RefundTicketRecord {
  return {
    refundId: row.refund_id,
    orderId: row.order_id,
    // NUMERIC 在 pg 驱动里回来是字符串（避免 float 精度丢失），这里显式转数字
    amount: typeof row.amount === 'string' ? Number(row.amount) : row.amount,
    reason: row.reason,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.getTime()
        : Date.parse(row.created_at),
  };
}

function newRefundId(): string {
  return `REF-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

/**
 * 退款工单的 PostgreSQL 实现。
 *
 * 幂等的**真实执行者是数据库的 `UNIQUE(order_id)` 约束**，不是应用层的检查。
 * v0.3 的 `InMemoryRefundStore` 靠进程内 Map —— 重启即失效，多实例完全无效，
 * 当时的 REPORT 里明确写了「不宣称生产级幂等」。这一版兑现。
 *
 * 关键在于 `ON CONFLICT (order_id) DO NOTHING` + 回查：
 * 不做「先查再插」（那是 TOCTOU 竞态，并发下两个请求都会查到空然后各自插入）。
 */
export class PgRefundStore implements RefundStore {
  constructor(private readonly db: Database) {}

  async findByOrderId(orderId: string): Promise<RefundTicketRecord | undefined> {
    const { rows } = await this.db.query<TicketRow>(
      `SELECT refund_id, order_id, amount, reason, created_at
       FROM refund_tickets WHERE order_id = $1`,
      [orderId]
    );
    return rows[0] ? toRecord(rows[0]) : undefined;
  }

  async createIfAbsent(input: {
    orderId: string;
    amount: number;
    reason: string;
  }): Promise<{ ticket: RefundTicketRecord; created: boolean }> {
    const { rows } = await this.db.query<TicketRow>(
      `INSERT INTO refund_tickets (refund_id, order_id, amount, reason)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (order_id) DO NOTHING
       RETURNING refund_id, order_id, amount, reason, created_at`,
      [newRefundId(), input.orderId, input.amount, input.reason]
    );

    if (rows[0]) {
      return { ticket: toRecord(rows[0]), created: true };
    }

    // 冲突了 —— 说明别人（或上一次）已经建过，回查那一单
    const existing = await this.findByOrderId(input.orderId);
    if (!existing) {
      // 理论上不可达：冲突意味着记录存在。真出现说明有并发删除，直接报出来不要猜
      throw new Error(
        `[refund] 订单 ${input.orderId} 插入冲突但回查不到工单，可能存在并发删除`
      );
    }
    return { ticket: existing, created: false };
  }
}
