export interface RefundTicket {
  refundId: string;
  orderId: string;
  amount: number;
  reason: string;
  createdAt: number;
}

/**
 * 退款工单存储。
 *
 * 存在的理由是**幂等**：v0.3 之前每次调用 `refund_apply` 都生成新工单号，
 * 同一订单可被反复提交 —— 真实业务里这是资金风险，也是客服投诉高发点。
 *
 * ⚠️ 当前实现是**进程内**的，重启即失效，因此本版不宣称「生产级幂等」。
 * 接口先定在这里，v0.5 引入 PostgreSQL 后换成带唯一约束（`UNIQUE(order_id)`）的
 * 持久化实现 —— 那才是真正防得住重启与多实例的幂等。
 */
export interface RefundStore {
  findByOrderId(orderId: string): RefundTicket | undefined;
  /** 已存在则返回原工单（不新建），否则创建并返回 */
  createIfAbsent(input: {
    orderId: string;
    amount: number;
    reason: string;
  }): { ticket: RefundTicket; created: boolean };
}

export class InMemoryRefundStore implements RefundStore {
  private readonly byOrderId = new Map<string, RefundTicket>();
  private seq = 0;

  findByOrderId(orderId: string): RefundTicket | undefined {
    return this.byOrderId.get(orderId);
  }

  createIfAbsent(input: {
    orderId: string;
    amount: number;
    reason: string;
  }): { ticket: RefundTicket; created: boolean } {
    // 这里是同步的检查-写入，因此在单线程 JS 里天然是原子的：
    // 三个并发 execute() 之间没有 await 切点，不会出现两个都查到空再各自插入。
    const existing = this.byOrderId.get(input.orderId);
    if (existing) {
      return { ticket: existing, created: false };
    }

    this.seq += 1;
    const ticket: RefundTicket = {
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

let defaultStore: RefundStore = new InMemoryRefundStore();

export function getDefaultRefundStore(): RefundStore {
  return defaultStore;
}

/** 测试隔离用：重置进程内单例 */
export function __resetRefundStore(): void {
  defaultStore = new InMemoryRefundStore();
}
