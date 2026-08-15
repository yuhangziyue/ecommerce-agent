/** 电商客服的意图分类。`unknown` 是识别失败/低置信度的兜底。 */
export type Intent =
  | 'order_query'
  | 'product_search'
  | 'after_sales'
  | 'refund'
  | 'logistics'
  | 'account'
  | 'complaint'
  | 'chitchat'
  | 'unknown';

export type SlotName =
  | 'orderId'
  | 'phoneLast4'
  | 'trackingNo'
  | 'productKeyword'
  | 'reason';

export type Slots = Partial<Record<SlotName, string>>;

/** 每个意图的必需槽位。任一组满足即可（数组内是「或」关系）。 */
export const REQUIRED_SLOTS: Record<Intent, SlotName[][]> = {
  order_query: [['orderId'], ['phoneLast4']],
  product_search: [],
  after_sales: [['orderId']],
  refund: [['orderId'], ['reason']],
  logistics: [['orderId'], ['trackingNo']],
  account: [],
  complaint: [],
  chitchat: [],
  unknown: [],
};

export const INTENT_LABELS: Record<Intent, string> = {
  order_query: '查询订单',
  product_search: '商品咨询',
  after_sales: '售后咨询',
  refund: '申请退款',
  logistics: '物流问题',
  account: '账户与发票',
  complaint: '投诉',
  chitchat: '寒暄',
  unknown: '未识别',
};

export interface IntentResult {
  intent: Intent;
  /** 0~1。低于阈值时调用方应降级为 unknown */
  confidence: number;
  slots: Slots;
}

export type IntentPhase = 'idle' | 'collecting' | 'ready' | 'switched';

export interface IntentState {
  intent: Intent;
  phase: IntentPhase;
  slots: Slots;
  /** 还缺的必需槽位（每组取第一个作为代表） */
  missing: SlotName[];
  confidence: number;
  /** 上一轮的意图，用于判断是否发生切换 */
  previousIntent?: Intent;
}

export const EMPTY_STATE: IntentState = {
  intent: 'unknown',
  phase: 'idle',
  slots: {},
  missing: [],
  confidence: 0,
};

/**
 * 判断必需槽位是否满足。
 * `REQUIRED_SLOTS` 里每个数组是一组「或」关系 —— 满足任意一组即算齐。
 */
export function findMissingSlots(intent: Intent, slots: Slots): SlotName[] {
  const groups = REQUIRED_SLOTS[intent];
  if (groups.length === 0) return [];

  const satisfied = groups.some((group) => group.every((s) => Boolean(slots[s])));
  if (satisfied) return [];

  // 未满足：把每组的第一个槽位作为「还缺什么」的代表
  return groups.map((group) => group[0]);
}
