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
      });
    case 'response':
      return frame('response', { content: event.content });
    case 'blocked':
      return frame('blocked', { by: event.by, reason: event.reason });
    case 'error':
      return frame('error', { message: event.error });
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
