import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, ToolResult } from '../core/types.js';
import { loadProducts } from '../data/loader.js';
import { MAX_LIST_ITEMS, type ProductCard } from '../artifacts/types.js';

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
  sortBy: Type.Optional(
    Type.String({
      description:
        '排序方式，比价场景使用：price_asc 价格从低到高 / price_desc 从高到低 / rating 评分优先',
      enum: ['price_asc', 'price_desc', 'rating'],
    })
  ),
  limit: Type.Optional(
    Type.Number({ description: `返回条数，默认 ${MAX_RESULTS}，最多 ${MAX_LIST_ITEMS}` })
  ),
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

    // v0.13 比价：排序在截断**之前**做 —— 反过来的话「最便宜的」
    // 只是「前 5 条里最便宜的」，而那是错的答案
    if (params.sortBy === 'price_asc') {
      products = [...products].sort((a, b) => a.price - b.price);
    } else if (params.sortBy === 'price_desc') {
      products = [...products].sort((a, b) => b.price - a.price);
    } else if (params.sortBy === 'rating') {
      products = [...products].sort((a, b) => b.rating - a.rating);
    }

    const total = products.length;
    const limit = Math.min(params.limit ?? MAX_RESULTS, MAX_LIST_ITEMS);
    products = products.slice(0, limit);

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

    const cards: ProductCard[] = products.map((p) => ({
      productId: p.productId,
      name: p.name,
      category: p.category,
      price: p.price,
      stock: p.stock,
      rating: p.rating,
      description: p.description,
      inStock: p.stock > 0,
    }));

    return {
      content:
        formatted +
        (total > products.length
          ? `\n---\n（共 ${total} 件匹配，以上为前 ${products.length} 件）`
          : ''),
      // v0.13：调用方拿这个渲染商品卡，不必从上面的中文里正则抠价格
      artifact: {
        type: 'product_list',
        data: { products: cards, total, truncated: total > products.length },
      },
      metadata: {
        count: products.length,
        // v0.2 修复：原为 p.id，而 products.json 的主键字段名是 productId，
        // 导致该数组恒为 [undefined, ...]。
        productIds: products.map((p) => p.productId),
      },
    };
  },
};
