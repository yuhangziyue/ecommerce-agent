import type { AgentEvent } from '../core/types.js';

/**
 * SSE 写出器：把 AgentEvent 逐条写成 Server-Sent Events。
 *
 * v0.4 把事件分发收敛到 EventBus 的回报在这里兑现 —— 它只是**又一个订阅者**，
 * AgentLoop 一行不用改。
 */
export interface SseSink {
  write(chunk: string): void;
  end(): void;
  readonly writable: boolean;
}

function frame(event: string, data: unknown): string {
  // SSE 规范：data 里不能有裸换行，JSON.stringify 已保证这一点
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** AgentEvent → SSE 帧。事件名与内部事件 1:1，调用方不需要额外映射表。 */
export function agentEventToSse(event: AgentEvent): string {
  switch (event.type) {
    case 'delta':
      return frame('delta', { text: event.text });
    case 'thinking':
      return frame('thinking', { content: event.content });
    case 'tool_start':
      return frame('tool_start', { tool: event.toolName, input: event.input });
    case 'tool_end':
      return frame('tool_end', {
        tool: event.toolName,
        duration_ms: event.durationMs,
        is_error: event.result.isError ?? false,
        // v0.13：结构化数据也挂在这里一份，省得客户端为了拿它去订阅两个事件
        artifact: event.result.artifact ?? null,
      });
    case 'tool_rejected':
      return frame('tool_rejected', { tool: event.toolName, reason: event.reason });
    case 'cancelled':
      return frame('cancelled', { reason: event.reason });
    case 'artifact':
      return frame('artifact', {
        tool: event.toolName,
        type: event.artifact.type,
        data: event.artifact.data,
      });
    case 'response':
      return frame('response', { content: event.content });
    case 'blocked':
      return frame('blocked', { by: event.by, reason: event.reason });
    case 'error':
      // v1.2：带上机器可读的分类与 retryable。
      // 只发一句中文的话，客户端要判断「该不该重试」只能做字符串匹配
      return frame('error', {
        message: event.error,
        code: event.code,
        retryable: event.retryable,
      });
    case 'done':
      return frame('done', {
        input_tokens: event.totalTokens.inputTokens,
        output_tokens: event.totalTokens.outputTokens,
        cost_usd: Number(event.totalCost.toFixed(6)),
      });
  }
}

export class SseWriter {
  private closed = false;

  constructor(private readonly sink: SseSink) {}

  /** 会话号必须最先发 —— 客户端要立刻拿到它才能续接下一轮 */
  writeSession(sessionId: string): void {
    this.safeWrite(frame('session', { session_id: sessionId }));
  }

  /** 意图识别结果（v0.8）。调用方可据此做前端提示或埋点。 */
  writeIntent(payload: {
    intent: string;
    confidence: number;
    phase: string;
    slots: Record<string, unknown>;
    missing: string[];
  }): void {
    this.safeWrite(frame('intent', payload));
  }

  /** 路由结果（v0.9）：本轮由哪个领域 Agent 处理 */
  writeRouting(payload: { agent: string; name: string; tools: string[] }): void {
    this.safeWrite(frame('routing', payload));
  }

  /**
   * 安全裁决（v0.10）。
   *
   * 只发规则 id / 名称 / 处置，**不发命中的原文** —— 那本身就是要保护的内容，
   * 通过 SSE 回给前端等于自己把它泄出去。
   */
  writeSafety(payload: {
    stage: 'input' | 'output';
    action: 'mask' | 'block' | 'handoff';
    rules: string[];
  }): void {
    this.safeWrite(frame('safety', payload));
  }

  /**
   * 配额越限（v0.11）。
   *
   * 流中途才越限的情况走这里 —— 响应头已经是 200，改不成 429 了。
   * `scope` 让客户端能区分「换个会话继续」和「你欠费了」。
   */
  writeQuota(payload: { scope: 'tenant' | 'session'; reason: string }): void {
    this.safeWrite(frame('quota', payload));
  }

  /**
   * 需要客户确认（v0.12）。
   *
   * 客户端拿到后应展示 `summary` 并给出「同意/拒绝」，
   * 再调 `POST /v1/confirmations/:id` —— 确认是一次独立往返，不阻塞本次响应。
   */
  writeConfirmationRequired(payload: {
    confirmation_id: string;
    tool: string;
    summary: string;
  }): void {
    this.safeWrite(frame('confirmation_required', payload));
  }

  writeEvent(event: AgentEvent): void {
    this.safeWrite(agentEventToSse(event));
  }

  writeError(code: string, message: string): void {
    this.safeWrite(frame('error', { code, message }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.sink.writable) this.sink.end();
  }

  /** 客户端已断开 —— 上层据此停止写出（本版不中断 Loop，见 SPEC 风险表） */
  markClosed(): void {
    this.closed = true;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private safeWrite(chunk: string): void {
    if (this.closed || !this.sink.writable) return;
    this.sink.write(chunk);
  }
}
