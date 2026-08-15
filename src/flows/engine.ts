import type {
  FlowDefinition,
  FlowRecord,
  FlowState,
  FlowStore,
  FlowTransition,
} from './types.js';

export type FireResult =
  | { ok: true; flow: FlowRecord; from: FlowState }
  | { ok: false; reason: string; flow: FlowRecord };

/**
 * 状态机引擎。
 *
 * 刻意**不做通用工作流引擎** —— 只够跑本项目的业务流：
 * 定义即数据（`FlowDefinition`），没有 DSL、没有表达式求值、没有插件机制。
 * 那些东西的复杂度只有在「运营要自己配流程」时才值得，而那是另一个产品。
 */
export class FlowEngine {
  private readonly definitions = new Map<string, FlowDefinition>();

  constructor(
    private readonly store: FlowStore,
    definitions: FlowDefinition[] = []
  ) {
    for (const def of definitions) this.register(def);
  }

  register(def: FlowDefinition): void {
    if (this.definitions.has(def.kind)) {
      throw new Error(`流程 ${def.kind} 重复注册`);
    }
    // 定义写错要在装配时就炸，而不是等到线上某个客户走到那一步
    const states = new Set([def.initial, ...def.terminal]);
    for (const rule of def.rules) {
      states.add(rule.from);
      states.add(rule.to);
    }
    for (const terminal of def.terminal) {
      if (def.rules.some((r) => r.from === terminal)) {
        throw new Error(`流程 ${def.kind}：终态 ${terminal} 不该有出边`);
      }
    }
    this.definitions.set(def.kind, def);
  }

  getDefinition(kind: string): FlowDefinition {
    const def = this.definitions.get(kind);
    if (!def) throw new Error(`未注册的流程类型: ${kind}`);
    return def;
  }

  /**
   * 开一条新流程。同一 subject 上已有活跃流程时**返回那一条**而不是新建 ——
   * 一个订单同时开两条退货流，后果是两张退款工单。
   */
  async start(input: {
    kind: string;
    sessionId: string;
    subjectId: string;
    data?: Record<string, unknown>;
  }): Promise<{ flow: FlowRecord; created: boolean }> {
    const def = this.getDefinition(input.kind);

    const existing = await this.store.findActiveBySubject(
      input.kind,
      input.subjectId,
      def.terminal
    );
    if (existing) return { flow: existing, created: false };

    const flow = await this.store.create({
      id: `flow_${input.kind}_${input.subjectId}_${Date.now().toString(36)}`,
      kind: input.kind,
      sessionId: input.sessionId,
      subjectId: input.subjectId,
      state: def.initial,
      data: input.data ?? {},
    });

    await this.store.appendTransition({
      flowId: flow.id,
      from: '(none)',
      to: def.initial,
      event: 'start',
      actor: 'system',
      at: Date.now(),
    });

    return { flow, created: true };
  }

  /**
   * 触发一次流转。
   *
   * 失败时返回**带原因的结果而不是抛异常** —— 这些「失败」大多是正常业务分支
   * （超出时效、金额需审批），要原样讲给客户听，不是程序错误。
   */
  async fire(
    flowId: string,
    event: string,
    payload: Record<string, unknown> = {},
    actor = 'agent'
  ): Promise<FireResult> {
    const flow = await this.store.get(flowId);
    if (!flow) throw new Error(`流程 ${flowId} 不存在`);

    const def = this.getDefinition(flow.kind);

    if (def.terminal.includes(flow.state)) {
      return {
        ok: false,
        flow,
        reason: `流程已处于终态「${flow.state}」，不能再执行「${event}」。`,
      };
    }

    const rule = def.rules.find((r) => r.from === flow.state && r.event === event);
    if (!rule) {
      const allowed = def.rules
        .filter((r) => r.from === flow.state)
        .map((r) => r.event);
      return {
        ok: false,
        flow,
        // 把「当前能做什么」一并给出：模型据此能自己纠正，而不是反复试错
        reason:
          `当前状态「${flow.state}」不支持「${event}」。` +
          (allowed.length > 0
            ? `当前可执行：${allowed.join('、')}。`
            : '当前无可执行操作。'),
      };
    }

    if (rule.guard) {
      const verdict = await rule.guard(flow, payload);
      if (!verdict.ok) return { ok: false, flow, reason: verdict.reason };
    }

    const from = flow.state;
    const patch = rule.apply ? rule.apply(flow, payload) : {};
    const updated = await this.store.update(flowId, rule.to, {
      ...flow.data,
      ...patch,
    });

    await this.store.appendTransition({
      flowId,
      from,
      to: rule.to,
      event,
      actor,
      note: typeof payload.note === 'string' ? payload.note : undefined,
      at: Date.now(),
    });

    return { ok: true, flow: updated, from };
  }

  async history(flowId: string): Promise<FlowTransition[]> {
    return this.store.getTransitions(flowId);
  }

  async get(flowId: string): Promise<FlowRecord | null> {
    return this.store.get(flowId);
  }

  /** 某业务主键上在途的流程。终态由定义提供，调用方不必自己知道有哪些终态 */
  async findActive(kind: string, subjectId: string): Promise<FlowRecord | null> {
    return this.store.findActiveBySubject(kind, subjectId, this.getDefinition(kind).terminal);
  }

  async listBySession(sessionId: string, limit?: number): Promise<FlowRecord[]> {
    return this.store.listBySession(sessionId, limit);
  }

  /** 当前状态下可执行的事件 —— 给模型看，让它知道下一步能干什么 */
  availableEvents(flow: FlowRecord): string[] {
    const def = this.getDefinition(flow.kind);
    if (def.terminal.includes(flow.state)) return [];
    return def.rules.filter((r) => r.from === flow.state).map((r) => r.event);
  }

  isTerminal(flow: FlowRecord): boolean {
    return this.getDefinition(flow.kind).terminal.includes(flow.state);
  }
}
