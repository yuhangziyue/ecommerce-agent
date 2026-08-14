import { orderLookupTool } from '../src/tools/order-lookup.js';

describe('orderLookupTool', () => {
  it('should lookup order by orderId', async () => {
    const result = await orderLookupTool.execute({ orderId: 'ORD-20260801-001' });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('张三');
    // v0.2：状态改为中文标签（从 index.ts 内联工具移植的映射）。
    // 断言应表达期望行为，而不是固化「把 shipped 原样丢给模型」这个不佳实现。
    expect(result.content).toContain('已发货，运输中');
    expect(result.content).toContain('顺丰');
    expect(result.content).toContain('SF1234567890');
  });

  it('should lookup order by phoneLast4', async () => {
    const result = await orderLookupTool.execute({ phoneLast4: '1234' });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('ORD-20260801-001');
    expect(result.metadata).toBeDefined();
    expect(result.metadata!.count).toBe(1);
  });

  it('should return "未找到" for non-existent order', async () => {
    const result = await orderLookupTool.execute({ orderId: 'ORD-NONEXIST-999' });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('未找到');
  });

  it('should return error when no params provided', async () => {
    const result = await orderLookupTool.execute({});

    expect(result.isError).toBe(true);
    expect(result.content).toContain('订单号');
    expect(result.content).toContain('手机号');
  });
});
