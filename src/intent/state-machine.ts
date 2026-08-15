import {
  EMPTY_STATE,
  INTENT_LABELS,
  findMissingSlots,
  type IntentResult,
  type IntentState,
} from './types.js';

const SLOT_LABELS: Record<string, string> = {
  orderId: '订单号',
  phoneLast4: '手机号后 4 位',
  trackingNo: '快递单号',
  productKeyword: '商品名称或关键词',
  reason: '原因',
};

/**
 * 多轮意图状态机。
 *
 * 三件事：
 * 1. **槽位继承** —— 同一意图延续时带上已收集的槽位（客户第 1 轮给订单号、第 3 轮说"退了吧"）
 * 2. **缺槽检测** —— 缺必需槽位时进入 `collecting`，并说明缺什么
 * 3. **切换检测** —— 意图变了就清空旧槽位，否则「退款的订单号」会被带进「查物流」
 */
export function advance(previous: IntentState, result: IntentResult): IntentState {
  // 识别不出来：保持原状态，不破坏正在进行的槽位收集
  if (result.intent === 'unknown') {
    return { ...previous, confidence: result.confidence };
  }

  const switched = previous.intent !== 'unknown' && previous.intent !== result.intent;

  // 切换时清空旧槽位 —— 跨意图继承槽位会查错单子
  const slots = switched
    ? { ...result.slots }
    : { ...previous.slots, ...result.slots };

  const missing = findMissingSlots(result.intent, slots);

  return {
    intent: result.intent,
    phase: switched ? 'switched' : missing.length > 0 ? 'collecting' : 'ready',
    slots,
    missing,
    confidence: result.confidence,
    previousIntent: switched ? previous.intent : previous.previousIntent,
  };
}

/**
 * 把状态渲染成注入 system 上下文的一段文字。
 *
 * **注入的是信息，不是命令**：告诉模型「你还缺订单号」，而不是「必须先问订单号」。
 * 前者让模型带着这个事实自己组织语言，后者会把对话变成机械问答 ——
 * 客户刚说完一长段，收到一句「请提供订单号」的体验是灾难性的。
 *
 * 返回 null 表示无需注入（unknown 意图时保持 v0.7 行为，不限制模型）。
 */
export function renderIntentContext(state: IntentState): string | null {
  if (state.intent === 'unknown') return null;

  const lines: string[] = [`## 本轮意图识别`, `识别为：${INTENT_LABELS[state.intent]}`];

  const known = Object.entries(state.slots).filter(([, v]) => v);
  if (known.length > 0) {
    lines.push(
      `已知信息：${known.map(([k, v]) => `${SLOT_LABELS[k] ?? k}=${v}`).join('；')}`
    );
  }

  if (state.phase === 'switched' && state.previousIntent) {
    lines.push(
      `注意：客户已从「${INTENT_LABELS[state.previousIntent]}」切换到新话题，` +
        `之前那个话题的信息不要再带入本轮回答。`
    );
  }

  if (state.missing.length > 0) {
    const names = state.missing.map((s) => SLOT_LABELS[s] ?? s).join(' 或 ');
    lines.push(
      `还缺：${names}。请用自然的方式向客户询问，不要机械复述这条提示；` +
        `如果客户在前文已经提到过，直接使用不要重复问。`
    );
  }

  if (state.intent === 'complaint') {
    lines.push('这是投诉。先安抚情绪并确认诉求，处理不了就用 human_handoff 转人工。');
  }

  return lines.join('\n');
}

export function stateFromUnknown(): IntentState {
  return { ...EMPTY_STATE };
}
