import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, ToolResult } from '../core/types.js';
import { loadProducts } from '../data/loader.js';

const MAX_RESULTS = 5;

const ProductSearchParams = Type.Object({
  keyword: Type.Optional(
    Type.String({ description: '搜索关键词，匹配商品名与描述，如「耳机」「保温杯」' })
  ),
  category: Type.Optional(
    Type.String({
      // v0.2 修复：原描述写的是「如 耳机、配件」，而真实数据只有以下三个分类。
      // description 是模型选参的唯一依据，写错会导致模型传入不存在的分类、永远返回空结果。
      description: '商品分类，只能是以下三者之一：电子产品 / 服饰 / 食品',
      enum: ['电子产品', '服饰', '食品'],
    })
  ),
  minPrice: Type.Optional(Type.Number({ description: '最低价格（元）' })),
  maxPrice: Type.Optional(Type.Number({ description: '最高价格（元）' })),
});
type ProductSearchParams = Static<typeof ProductSearchParams>;

export const productSearchTool: AgentTool<typeof ProductSearchParams> = {
  name: 'product_search',
  description:
    `搜索商品，支持关键词、分类、价格区间组合筛选，最多返回 ${MAX_RESULTS} 件。` +
    '当客户询问有什么商品、想比价、问某类商品推荐或库存时调用。',
  parameters: ProductSearchParams,
  riskLevel: 'low',
  execute: async (params: ProductSearchParams): Promise<ToolResult> => {
    let products = loadProducts();

    if (params.keyword) {
      const kw = params.keyword.toLowerCase();
      products = products.filter(
        (p) =>
          p.name.toLowerCase().includes(kw) ||
          p.description.toLowerCase().includes(kw)
      );
    }

    if (params.category) {
      products = products.filter((p) => p.category === params.category);
    }

    if (params.minPrice !== undefined) {
      products = products.filter((p) => p.price >= params.minPrice!);
    }

    if (params.maxPrice !== undefined) {
      products = products.filter((p) => p.price <= params.maxPrice!);
    }

    products = products.slice(0, MAX_RESULTS);

    if (products.length === 0) {
      return {
        content: '没有找到匹配的商品，请尝试调整搜索条件。',
        isError: false,
      };
    }

    const formatted = products
      .map(
        (p) =>
          `[${p.productId}] ${p.name}\n` +
          `价格: ¥${p.price} | 分类: ${p.category} | 评分: ${p.rating}\n` +
          `${p.description}\n` +
          `库存: ${p.stock > 0 ? `有货（${p.stock}件）` : '缺货'}`
      )
      .join('\n---\n');

    return {
      content: formatted,
      metadata: {
        count: products.length,
        // v0.2 修复：原为 p.id，而 products.json 的主键字段名是 productId，
        // 导致该数组恒为 [undefined, ...]。
        productIds: products.map((p) => p.productId),
      },
    };
  },
};
