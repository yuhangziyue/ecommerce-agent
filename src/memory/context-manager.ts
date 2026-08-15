import { Message } from '../core/types.js';

export class ContextManager {
  private maxMessages: number;

  constructor(maxMessages: number = 20) {
    this.maxMessages = maxMessages;
  }

  /**
   * 配对感知裁剪。
   *
   * 为什么需要它：Anthropic API 要求每个 `tool_result` 必须紧跟在产生它的
   * `tool_use` 之后。固定窗口盲切一旦落在这对中间，请求会被拒（400），
   * 表现为「多轮对话到某一轮突然全部失败」，且很难定位。
   *
   * 策略：先按窗口算出候选切点，再把切点移到真正的「用户轮次边界」（role === 'user'）——
   * 优先向后推（丢弃更多但更干净），向后找不到就向前回退（多留几条，保证不切散）。
   */
  trimSafely(messages: Message[]): Message[] {
    if (messages.length <= this.maxMessages) {
      return messages;
    }

    const systemMessages = messages.filter(m => m.role === 'system');
    const rest = messages.filter(m => m.role !== 'system');

    // system 消息不占对话预算的名额时至少留 1 条对话消息，避免只剩 system
    const budget = Math.max(1, this.maxMessages - systemMessages.length);
    if (rest.length <= budget) {
      return [...systemMessages, ...rest];
    }

    const candidate = rest.length - budget;
    const boundary = ContextManager.findTurnBoundary(rest, candidate);

    return [...systemMessages, ...rest.slice(boundary)];
  }

  /**
   * 找到不早于/不晚于 candidate 的最近一个用户轮次起点。
   * 一轮对话总是从 user 消息开始，因此以 role === 'user' 作为安全切点。
   */
  private static findTurnBoundary(messages: Message[], candidate: number): number {
    for (let i = candidate; i < messages.length; i++) {
      if (messages[i].role === 'user') return i;
    }
    for (let i = candidate - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return i;
    }
    // 整段没有 user 消息（理论上不该出现）——全部保留，交给上游预算熔断处理
    return 0;
  }
}
