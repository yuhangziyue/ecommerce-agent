export type FlowState = string;
export type FlowEvent = string;

export interface FlowRecord {
  id: string;
  kind: string;
  sessionId: string;
  /** 业务主键（订单号）。同一订单同时只应有一条活跃流程 */
  subjectId: string;
  state: FlowState;
  data: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface FlowTransition {
  flowId: string;
  from: FlowState;
  to: FlowState;
  event: FlowEvent;
  /** 谁触发的：`customer` / `agent` / `system` / 具体审批人 */
  actor: string;
  note?: string;
  at: number;
}

/**
 * 守卫的结果。
 *
 * 刻意不用 boolean —— 拒绝时**必须给出理由**，因为这个理由会原样传给模型，
 * 再由模型转述给客户。「不能退货」和「已签收超过 7 天（实际 12 天），
 * 超出售后时效」对客户是完全不同的两句话。
 */
export type GuardResult = { ok: true } | { ok: false; reason: string };

export interface TransitionRule {
  from: FlowState;
  event: FlowEvent;
  to: FlowState;
  /** 守卫拿到当前流程数据与事件载荷，决定这次流转是否允许 */
  guard?: (
    flow: FlowRecord,
    payload: Record<string, unknown>
  ) => GuardResult | Promise<GuardResult>;
  /** 流转时对 data 的更新（浅合并） */
  apply?: (
    flow: FlowRecord,
    payload: Record<string, unknown>
  ) => Record<string, unknown>;
}

export interface FlowDefinition {
  kind: string;
  initial: FlowState;
  /** 终态集合。到了终态就不再接受任何事件 */
  terminal: FlowState[];
  rules: TransitionRule[];
}

export interface FlowStore {
  create(input: {
    id: string;
    kind: string;
    sessionId: string;
    subjectId: string;
    state: FlowState;
    data?: Record<string, unknown>;
  }): Promise<FlowRecord>;
  get(id: string): Promise<FlowRecord | null>;
  /** 找某业务主键上**未终结**的流程 —— 一个订单不该同时开两条退货流 */
  findActiveBySubject(kind: string, subjectId: string, terminal: FlowState[]): Promise<FlowRecord | null>;
  listBySession(sessionId: string, limit?: number): Promise<FlowRecord[]>;
  update(id: string, state: FlowState, data: Record<string, unknown>): Promise<FlowRecord>;
  appendTransition(t: FlowTransition): Promise<void>;
  getTransitions(flowId: string): Promise<FlowTransition[]>;
}

// ============ 异步确认 ============

export type ConfirmationStatus = 'pending' | 'approved' | 'rejected' | 'consumed';

export interface ConfirmationRecord {
  id: string;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** 给人看的一句话摘要：「为订单 X 申请退款 ¥Y」 */
  summary: string;
  status: ConfirmationStatus;
  decidedBy?: string;
  createdAt: number;
  decidedAt?: number;
  consumedAt?: number;
}

export interface ConfirmationStore {
  create(input: {
    id: string;
    sessionId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    summary: string;
  }): Promise<ConfirmationRecord>;
  get(id: string): Promise<ConfirmationRecord | null>;
  /** 找该会话中针对同一工具+入参的未决确认单，避免每轮都新建一张 */
  findPending(
    sessionId: string,
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<ConfirmationRecord | null>;
  /** 仅当当前为 `pending` 时才生效，返回 null 表示已被决策过（防重复决策） */
  decide(
    id: string,
    approved: boolean,
    decidedBy: string
  ): Promise<ConfirmationRecord | null>;
  /** 仅当当前为 `approved` 时才生效，返回 null 表示不可消费（防重放） */
  consume(id: string): Promise<ConfirmationRecord | null>;
  listBySession(sessionId: string, limit?: number): Promise<ConfirmationRecord[]>;
}
