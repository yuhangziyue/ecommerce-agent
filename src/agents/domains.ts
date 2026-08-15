import type { DomainAgent } from './types.js';

export const PRESALE_AGENT: DomainAgent = {
  id: 'presale',
  name: '售前顾问',
  description: '商品咨询、推荐、比价',
  intents: ['product_search', 'chitchat'],
  systemPrompt: `## 本轮领域：售前顾问
- 先用 product_search 查真实库存与价格，不要凭印象推荐
- 客户没给预算时，先给 2-3 个不同价位的选项，再问偏好
- 缺货商品要主动说明，并给可替代的同类商品
- 不要在售前阶段主动提退换货政策，除非客户问起`,
  toolNames: ['product_search', 'faq_search'],
};

export const ORDER_AGENT: DomainAgent = {
  id: 'order',
  name: '订单与物流',
  description: '查订单状态、物流进度、催发货',
  intents: ['order_query', 'logistics'],
  systemPrompt: `## 本轮领域：订单与物流
- 一律先用 order_lookup 取真实状态，禁止凭记忆描述物流进度
- 报物流必须带快递公司与运单号
- 客户催发货时，先说明当前真实状态，再给预计时间，不要承诺无法保证的时效
- 涉及改地址：先确认订单是否已发货，已发货的要说明只能联系快递`,
  toolNames: ['order_lookup', 'faq_search'],
};

export const AFTERSALE_AGENT: DomainAgent = {
  id: 'aftersale',
  name: '售后处理',
  description: '退换货咨询、退款申请',
  intents: ['after_sales', 'refund'],
  systemPrompt: `## 本轮领域：售后处理
- 退款前必须先 order_lookup 确认订单状态与金额，再与客户确认订单号和原因
- 未付款订单引导取消而非退款；已退款订单直接告知无需重复申请
- refund_apply 是高风险操作：确认无误才调用，调用后如实转述工单号与到账时间
- 政策类问题先 faq_search 找标准答案，不要自行发挥
- 客户情绪激动或诉求超出范围时用 human_handoff 转人工`,
  toolNames: ['order_lookup', 'refund_apply', 'faq_search', 'human_handoff'],
};

export const ACCOUNT_AGENT: DomainAgent = {
  id: 'account',
  name: '账户与发票',
  description: '会员权益、发票、账户设置',
  intents: ['account'],
  systemPrompt: `## 本轮领域：账户与发票
- 权益与发票规则一律 faq_search 查标准答案，口径不能自造
- 涉及个人敏感信息（证件、银行卡）时不要在对话里索取，引导走官方渠道
- 处理不了的账户操作用 human_handoff 转人工`,
  toolNames: ['faq_search', 'human_handoff'],
};

/**
 * 兜底 Agent。
 *
 * **拿全部工具是刻意的**：意图识别不出来时收窄工具面等于让 Agent 更无能。
 * 兜底路径应该保持 v0.8 的能力，而不是比它更弱。
 */
export const GENERAL_AGENT: DomainAgent = {
  id: 'general',
  name: '通用客服',
  description: '意图不明确或投诉场景的兜底',
  intents: ['unknown', 'complaint'],
  systemPrompt: `## 本轮领域：通用客服
- 客户诉求不清楚时先问清楚再动手，不要猜着调工具
- 投诉场景：先共情与安抚，确认具体诉求，再看能否处理；
  处理不了或客户明确要求人工时立刻 human_handoff，不要反复解释`,
  toolNames: [], // 空数组 = 全部工具
};

export const ALL_DOMAIN_AGENTS: DomainAgent[] = [
  PRESALE_AGENT,
  ORDER_AGENT,
  AFTERSALE_AGENT,
  ACCOUNT_AGENT,
  GENERAL_AGENT,
];
