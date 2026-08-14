import { AgentTool, ToolResult } from '../core/types.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFaqs(): any[] {
  const dataPath = path.join(__dirname, '..', 'data', 'faqs.json');
  return JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
}

export const faqSearchTool: AgentTool = {
  name: 'faq_search',
  description: '搜索常见问题解答',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
    },
    required: ['query'],
  },
  riskLevel: 'low',
  execute: async (params: { query: string }): Promise<ToolResult> => {
    const faqs = loadFaqs();
    const query = params.query.toLowerCase();

    // Score each FAQ by keyword match count
    const scored = faqs.map((faq: any) => {
      let score = 0;
      if (faq.question.toLowerCase().includes(query)) score += 3;
      if (faq.answer.toLowerCase().includes(query)) score += 1;
      if (faq.category && query.includes(faq.category.toLowerCase())) score += 2;
      return { faq, score };
    });

    // Filter and sort by score, take top 3
    const results = scored
      .filter((s: any) => s.score > 0)
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, 3);

    if (results.length === 0) {
      return {
        content: '没有找到相关的常见问题。建议您联系人工客服获取帮助，或尝试用不同的关键词搜索。',
        isError: false,
      };
    }

    const formatted = results
      .map((r: any) => `Q: ${r.faq.question}\nA: ${r.faq.answer}`)
      .join('\n---\n');

    return {
      content: formatted,
      metadata: { count: results.length, faqIds: results.map((r: any) => r.faq.id) },
    };
  },
};
