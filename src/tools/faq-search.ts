import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, ToolResult } from '../core/types.js';
import { loadFaqs } from '../data/loader.js';

const MAX_RESULTS = 3;

/** 命中不同字段的权重：标题命中最相关，正文次之，分类命中作为兜底信号 */
const WEIGHT = { question: 3, answer: 1, category: 2 } as const;

const FaqSearchParams = Type.Object({
  query: Type.String({
    description:
      '搜索关键词，如 退换货 / 配送 / 支付 / 会员 / 发票 / 优惠券 / 订单 / 客服',
  }),
});
type FaqSearchParams = Static<typeof FaqSearchParams>;

export const faqSearchTool: AgentTool<typeof FaqSearchParams> = {
  name: 'faq_search',
  description:
    `搜索平台常见问题解答，按相关度返回最相关的 ${MAX_RESULTS} 条。` +
    '当客户询问规则类问题（退换货政策、配送时效、支付方式、会员权益、发票、优惠活动）时' +
    '优先调用，用标准答案回复，不要凭记忆作答。',
  parameters: FaqSearchParams,
  riskLevel: 'low',
  execute: async (params: FaqSearchParams): Promise<ToolResult> => {
    const faqs = loadFaqs();
    const query = params.query.toLowerCase();

    const scored = faqs.map((faq) => {
      let score = 0;
      if (faq.question.toLowerCase().includes(query)) score += WEIGHT.question;
      if (faq.answer.toLowerCase().includes(query)) score += WEIGHT.answer;
      if (faq.category && query.includes(faq.category.toLowerCase())) {
        score += WEIGHT.category;
      }
      return { faq, score };
    });

    const results = scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS);

    if (results.length === 0) {
      return {
        content:
          '没有找到相关的常见问题。建议换个关键词，或转人工客服获取帮助。',
        isError: false,
      };
    }

    const formatted = results
      .map((r) => `Q: ${r.faq.question}\nA: ${r.faq.answer}`)
      .join('\n---\n');

    return {
      content: formatted,
      metadata: {
        count: results.length,
        faqIds: results.map((r) => r.faq.id),
      },
    };
  },
};
