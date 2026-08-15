import type { ConfirmationRecord, ConfirmationStore } from './types.js';

export type ConfirmOutcome =
  /** 已批准且已消费，工具可以真正执行 */
  | { decision: 'approved'; confirmation: ConfirmationRecord }
  /** 等待客户确认 —— 这一轮不执行，但要告诉模型「在等确认」而不是「被取消」 */
  | { decision: 'pending'; confirmation: ConfirmationRecord }
  | { decision: 'rejected'; confirmation: ConfirmationRecord };

/**
 * 异步确认服务。
 *
 * 为什么需要它：**CLI 的确认是同步的（等用户敲 y），HTTP 的确认不可能同步** ——
 * 请求不能挂在那里等人点确认。v0.6 的处置是服务端一律拒绝高风险工具，
 * 并把拒绝理由写成「用户取消了该操作」。
 *
 * 那句话是假的，而假话的代价是连锁的：模型拿到「用户取消了」，
 * 合理地推断出事情办完了，回客户一句「已处理」—— 客户以为退款提交了，
 * 实际什么都没发生，而且日志里查不到任何异常。
 *
 * 这里把确认变成一次真实的往返：生成确认单 → 客户端调 API 决策 → 下一轮执行。
 */
export class ConfirmationService {
  constructor(private readonly store: ConfirmationStore) {}

  /**
   * 高风险工具执行前调用。
   *
   * 同一会话中相同工具+入参的未决确认单会被**复用**而不是每轮新建 ——
   * 否则模型每重试一次，客户就多收到一条「请确认」，全都指向同一件事。
   */
  async require(input: {
    sessionId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    summary: string;
  }): Promise<ConfirmOutcome> {
    const existing = await this.store.findPending(
      input.sessionId,
      input.toolName,
      input.toolInput
    );
    if (existing) return { decision: 'pending', confirmation: existing };

    // 找已决策但未消费的（客户端刚刚批准，这一轮该执行了）
    const decided = await this.findDecided(input);
    if (decided) {
      if (decided.status === 'rejected') {
        return { decision: 'rejected', confirmation: decided };
      }
      const consumed = await this.store.consume(decided.id);
      // consume 返回 null 说明并发下已被别人消费掉了 —— 当作未批准处理，
      // 宁可让客户再确认一次，也不能执行两次退款
      if (consumed) return { decision: 'approved', confirmation: consumed };
    }

    const created = await this.store.create({
      id: `cfm_${Date.now().toString(36)}_${Math.floor(performance.now() * 1000) % 46656}`,
      sessionId: input.sessionId,
      toolName: input.toolName,
      toolInput: input.toolInput,
      summary: input.summary,
    });
    return { decision: 'pending', confirmation: created };
  }

  /** 找该会话中相同工具+入参、已批准/已拒绝但尚未消费的确认单 */
  private async findDecided(input: {
    sessionId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
  }): Promise<ConfirmationRecord | null> {
    const all = await this.store.listBySession(input.sessionId, 50);
    const key = JSON.stringify(sortKeys(input.toolInput));
    return (
      all.find(
        (c) =>
          c.toolName === input.toolName &&
          (c.status === 'approved' || c.status === 'rejected') &&
          JSON.stringify(sortKeys(c.toolInput)) === key
      ) ?? null
    );
  }

  async decide(
    id: string,
    approved: boolean,
    decidedBy = 'customer'
  ): Promise<ConfirmationRecord | null> {
    return this.store.decide(id, approved, decidedBy);
  }

  async get(id: string): Promise<ConfirmationRecord | null> {
    return this.store.get(id);
  }

  async listBySession(sessionId: string, limit?: number): Promise<ConfirmationRecord[]> {
    return this.store.listBySession(sessionId, limit);
  }
}

/** 键序无关的比较：`{a,b}` 与 `{b,a}` 是同一个入参 */
function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * 生成给人看的确认摘要。
 *
 * 摘要是**客户点「同意」时唯一会读的东西** —— 必须包含金额与订单号这类
 * 一眼能核对的信息，不能是「确认执行 refund_apply」这种给机器看的话。
 */
export function summarizeToolCall(
  toolName: string,
  input: Record<string, unknown>
): string {
  switch (toolName) {
    case 'refund_apply':
      return `为订单 ${input.orderId ?? '(未知)'} 提交退款申请，原因：${input.reason ?? '(未填写)'}`;
    case 'return_request':
      return `为订单 ${input.orderId ?? '(未知)'} 发起退货退款，原因：${input.reason ?? '(未填写)'}`;
    default:
      return `执行操作「${toolName}」，参数：${JSON.stringify(input)}`;
  }
}
