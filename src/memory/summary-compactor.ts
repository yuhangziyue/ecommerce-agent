import type { ChatProvider, Message } from '../core/types.js';

export interface CompactorOptions {
  provider: ChatProvider;
  model: string;
  /** 消息数超过它才触发压缩，默认 24 */
  threshold?: number;
  /** 最近这么多条保留原文不压，默认 8 */
  keepRecent?: number;
}

export interface CompactionResult {
  /** 摘要正文 */
  summary: string;
  /** 被压缩掉的原始消息条数 */
  compactedCount: number;
}

const COMPACT_PROMPT = `你在压缩一段电商客服对话的早期历史，目的是让后续对话仍能引用其中的事实。

要求：
1. **必须逐字保留所有标识类信息**：订单号、手机号后四位、快递单号、商品名与型号、金额、日期
2. 保留客户明确表达过的诉求与偏好（要退货、指定收货时间、投诉过什么）
3. 保留已经做过的操作与结论（已提交退款工单 REF-xxx、已告知配送时效）
4. 省略寒暄、重复确认、以及已经作废的中间讨论
5. 用简洁的第三人称陈述，不要写成对话
6. 只输出摘要正文，不要任何前后缀说明`;

/**
 * 中期记忆：把被滑窗挤出去的历史压成一条摘要。
 *
 * 为什么中期这一层不能省：只有「短期滑窗 + 长期画像」时，滑窗一丢就是硬丢失。
 * 真实客服对话里「刚才说的那个订单」极常见，而它往往正好在窗口边缘。
 */
export class SummaryCompactor {
  private readonly threshold: number;
  private readonly keepRecent: number;

  constructor(private readonly opts: CompactorOptions) {
    this.threshold = opts.threshold ?? 24;
    this.keepRecent = opts.keepRecent ?? 8;
  }

  shouldCompact(messages: Message[]): boolean {
    return messages.length > this.threshold;
  }

  /**
   * 压缩最老的一段。返回 null 表示不需要压缩、或压缩失败。
   *
   * **压缩失败降级为不压缩**：绝不因为摘要生成失败而拒绝服务 ——
   * 那是把一个优化变成了单点故障。
   */
  async compact(messages: Message[]): Promise<CompactionResult | null> {
    if (!this.shouldCompact(messages)) return null;

    const cutoff = this.findCutoff(messages);
    if (cutoff <= 0) return null;

    const toCompact = messages.slice(0, cutoff);
    const transcript = toCompact
      .map((m) => {
        const who =
          m.role === 'user' ? '客户' : m.role === 'assistant' ? '客服' : '工具结果';
        return `${who}: ${m.content}`;
      })
      .filter((line) => line.trim().length > 3)
      .join('\n');

    if (!transcript.trim()) return null;

    try {
      const response = await this.opts.provider.chat(
        COMPACT_PROMPT,
        [{ role: 'user', content: transcript, timestamp: Date.now() }],
        []
      );
      const summary = response.content.trim();
      if (!summary) return null;

      return { summary, compactedCount: cutoff };
    } catch (err) {
      // 降级：不压缩，只记警告。压缩是优化，不该成为单点故障
      console.warn(
        `[compactor] 摘要生成失败，本轮跳过压缩：${(err as Error).message}`
      );
      return null;
    }
  }

  /**
   * 找到切点：保留最近 keepRecent 条，且切点必须落在**用户轮次边界**上。
   *
   * 与 `ContextManager.trimSafely` 同一个理由 —— 切点落在 assistant(tool_use) 与
   * 其 tool_result 之间，会让剩下的消息序列缺配对，被 API 拒绝。
   */
  private findCutoff(messages: Message[]): number {
    const candidate = messages.length - this.keepRecent;
    if (candidate <= 0) return 0;

    for (let i = candidate; i < messages.length; i++) {
      if (messages[i].role === 'user') return i;
    }
    for (let i = candidate - 1; i > 0; i--) {
      if (messages[i].role === 'user') return i;
    }
    return 0;
  }
}
