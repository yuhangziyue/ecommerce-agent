import type { RefundStore, RefundTicketRecord } from '../store/types.js';

export type { RefundStore, RefundTicketRecord };

/**
 * 进程内退款工单存储。
 *
 * ⚠️ **仅用于没有数据库的最小化排障场景**。重启即失效、多实例完全无效。
 * v0.5 起生产路径走 `PgRefundStore`（靠 `UNIQUE(order_id)` 保证真幂等），
 * 由 `src/index.ts` 在启动时通过 {@link setRefundStore} 注入。
 */
export class InMemoryRefundStore implements RefundStore {
  private readonly byOrderId = new Map<string, RefundTicketRecord>();
  private seq = 0;

  async findByOrderId(orderId: string): Promise<RefundTicketRecord | undefined> {
    return this.byOrderId.get(orderId);
  }

  async createIfAbsent(input: {
    orderId: string;
    amount: number;
    reason: string;
  }): Promise<{ ticket: RefundTicketRecord; created: boolean }> {
    const existing = this.byOrderId.get(input.orderId);
    if (existing) {
      return { ticket: existing, created: false };
    }

    this.seq += 1;
    const ticket: RefundTicketRecord = {
      refundId: `REF-${Date.now()}-${String(this.seq).padStart(4, '0')}`,
      orderId: input.orderId,
      amount: input.amount,
      reason: input.reason,
      createdAt: Date.now(),
    };
    this.byOrderId.set(input.orderId, ticket);
    return { ticket, created: true };
  }
}

let currentStore: RefundStore = new InMemoryRefundStore();

export function getDefaultRefundStore(): RefundStore {
  return currentStore;
}

/** 启动时注入真实实现（v0.5 起为 `PgRefundStore`） */
export function setRefundStore(store: RefundStore): void {
  currentStore = store;
}

/** 测试隔离用：恢复为全新的进程内实现 */
export function __resetRefundStore(): void {
  currentStore = new InMemoryRefundStore();
}
