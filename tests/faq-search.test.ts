import { faqSearchTool } from '../src/tools/faq-search.js';

describe('faqSearchTool', () => {
  it('should match FAQ about return policy for query "退换货"', async () => {
    const result = await faqSearchTool.execute({ query: '退换货' });

    expect(result.content).toContain('退换货');
    expect(result.content).toContain('7天');
    expect(result.metadata).toBeDefined();
    expect((result.metadata!.count as number)).toBeGreaterThanOrEqual(1);
  });

  it('should match payment FAQs for query "支付"', async () => {
    const result = await faqSearchTool.execute({ query: '支付' });

    expect(result.content).toContain('支付');
    expect(result.metadata).toBeDefined();
    expect((result.metadata!.count as number)).toBeGreaterThanOrEqual(1);
  });

  it('should return "没有找到相关的常见问题" for unmatched query', async () => {
    const result = await faqSearchTool.execute({ query: '外星人入侵地球xyz' });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('没有找到相关的常见问题');
  });

  it('should cap results at 3', async () => {
    // "退换货" could match multiple FAQs (ids 1,2,3 all in 退换货 category)
    const result = await faqSearchTool.execute({ query: '退换货' });

    const segments = result.content.split('---');
    expect(segments.length).toBeLessThanOrEqual(3);
  });
});
