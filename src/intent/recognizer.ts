import { INTENT_LABELS, type Intent, type IntentResult, type Slots } from './types.js';
import type { ChatProvider, Message } from '../core/types.js';

const VALID_INTENTS = Object.keys(INTENT_LABELS) as Intent[];

const RECOGNIZE_PROMPT = `你是电商客服系统的意图识别模块。读用户最新一句话（结合前文），输出 JSON。

可选意图：
- order_query   查订单状态/详情
- product_search 找商品、比价、要推荐
- after_sales   退换货政策咨询（还没到实际申请退款那一步）
- refund        明确要求退款
- logistics     物流异常、催发货、改地址
- account       会员、发票、账户设置
- complaint     投诉、表达强烈不满
- chitchat      寒暄、闲聊、感谢
- unknown       看不出来

可抽取的槽位（只抽**用户明确说过的**，不要推测、不要编造）：
- orderId        订单号，形如 ORD-20260801-001
- phoneLast4     手机号后 4 位
- trackingNo     快递单号
- productKeyword 用户提到的商品关键词
- reason         退款/投诉的原因

只输出 JSON，不要任何解释：
{"intent":"...","confidence":0.0~1.0,"slots":{"orderId":"..."}}

confidence 反映你的把握程度。看不准就给低分并用 unknown —— 猜错比说不知道更糟。`;

export interface RecognizerOptions {
  provider: ChatProvider;
  /** 低于此置信度降级为 unknown，默认 0.6 */
  minConfidence?: number;
  /** 喂给识别器的最近上下文轮数，默认 6 */
  contextTurns?: number;
}

/**
 * 从模型输出里宽松地抽出 JSON。
 *
 * 模型有时会带前后缀（"好的，结果是：{...}"）或包在 ```json 里。
 * 直接 `JSON.parse` 会炸，而识别失败**不该阻断对话** —— 提取第一个平衡的
 * `{...}` 块，失败就返回 null 让调用方降级。
 */
export function extractJson(text: string): unknown | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const UNKNOWN: IntentResult = { intent: 'unknown', confidence: 0, slots: {} };

export class IntentRecognizer {
  private readonly minConfidence: number;
  private readonly contextTurns: number;

  constructor(private readonly opts: RecognizerOptions) {
    this.minConfidence = opts.minConfidence ?? 0.6;
    this.contextTurns = opts.contextTurns ?? 6;
  }

  /**
   * 识别本轮意图。**任何失败都降级为 `unknown`，绝不抛异常** ——
   * 意图识别是增强，识别不准时应该让模型按原来的方式自由发挥，
   * 而不是反过来限制它。
   */
  async recognize(userInput: string, history: Message[] = []): Promise<IntentResult> {
    // 只喂最近几轮，不喂全量历史 —— 识别是每轮都跑的，成本要压住
    const context = history
      .slice(-this.contextTurns)
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => `${m.role === 'user' ? '客户' : '客服'}: ${m.content}`)
      .join('\n');

    const prompt = context
      ? `前文：\n${context}\n\n客户最新一句：${userInput}`
      : `客户最新一句：${userInput}`;

    let raw: string;
    try {
      const response = await this.opts.provider.chat(
        RECOGNIZE_PROMPT,
        [{ role: 'user', content: prompt, timestamp: Date.now() }],
        []
      );
      raw = response.content;
    } catch (err) {
      console.warn(`[intent] 识别调用失败，降级 unknown：${(err as Error).message}`);
      return UNKNOWN;
    }

    const parsed = extractJson(raw);
    if (!parsed || typeof parsed !== 'object') return UNKNOWN;

    const obj = parsed as Record<string, unknown>;
    const intent = VALID_INTENTS.includes(obj.intent as Intent)
      ? (obj.intent as Intent)
      : 'unknown';
    const confidence =
      typeof obj.confidence === 'number' && obj.confidence >= 0 && obj.confidence <= 1
        ? obj.confidence
        : 0;

    // 置信度不够就不做强断言 —— 宁可当作没识别出来
    if (intent === 'unknown' || confidence < this.minConfidence) {
      return { intent: 'unknown', confidence, slots: {} };
    }

    return { intent, confidence, slots: sanitizeSlots(obj.slots) };
  }
}

/** 只保留已知槽位名且值为非空字符串的项 —— 模型可能返回额外字段或 null */
function sanitizeSlots(raw: unknown): Slots {
  if (!raw || typeof raw !== 'object') return {};
  const allowed: Array<keyof Slots> = [
    'orderId',
    'phoneLast4',
    'trackingNo',
    'productKeyword',
    'reason',
  ];

  const slots: Slots = {};
  for (const key of allowed) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) {
      slots[key] = value.trim();
    }
  }
  return slots;
}
