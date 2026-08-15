import { productSearchTool } from '../src/tools/product-search.js';

describe('productSearchTool', () => {
  it('should find product by keyword "耳机"', async () => {
    const result = await productSearchTool.execute({ keyword: '耳机' });

    expect(result.content).toContain('无线蓝牙耳机Pro');
    expect(result.metadata).toBeDefined();
  });

  it('should filter by category "服饰"', async () => {
    const result = await productSearchTool.execute({ category: '服饰' });

    expect(result.content).not.toContain('无线蓝牙耳机Pro');
    // 服饰 category items: 纯棉T恤, 真丝衬衫, 运动跑鞋, 羊绒围巾, 牛仔外套, 休闲运动裤
    expect(result.content).toContain('纯棉T恤');
    expect(result.content).toContain('服饰');
  });

  it('should filter by price range', async () => {
    const result = await productSearchTool.execute({ minPrice: 300, maxPrice: 500 });

    // Products in range: 机械键盘K8(459), 运动跑鞋(399), 羊绒围巾(329), 牛仔外套(349)
    expect(result.content).not.toContain('无线蓝牙耳机Pro'); // 299, below range
    expect(result.content).toContain('机械键盘K8');
  });

  it('should return "没有找到匹配的商品" for unmatched search', async () => {
    const result = await productSearchTool.execute({ keyword: '不存在的商品xyz' });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('没有找到匹配的商品');
  });

  it('should cap results at 5', async () => {
    // category 服饰 has 6 items, should return only 5
    const result = await productSearchTool.execute({ category: '服饰' });

    // v0.13：断言结构而不是文案分段。原来的写法是数 `---` 的个数 ——
    // 加一行「共 6 件匹配」的说明就会把它弄红，而行为一个字没变。
    // 这正是本版要解决的问题：正确性判据不该建立在自然语言的排版上。
    expect(result.artifact?.type).toBe('product_list');
    const data = (result.artifact as any).data;
    expect(data.products).toHaveLength(5);
    expect(data.total).toBe(6);
    expect(data.truncated).toBe(true);
  });
});
