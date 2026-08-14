import { AgentTool, ToolResult } from '../core/types.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadProducts(): any[] {
  const dataPath = path.join(__dirname, '..', 'data', 'products.json');
  return JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
}

export const productSearchTool: AgentTool = {
  name: 'product_search',
  description: '搜索商品，支持关键词、分类和价格区间筛选',
  parameters: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '搜索关键词' },
      category: { type: 'string', description: '商品分类，如 耳机、配件' },
      minPrice: { type: 'number', description: '最低价格' },
      maxPrice: { type: 'number', description: '最高价格' },
    },
    required: [],
  },
  riskLevel: 'low',
  execute: async (params: {
    keyword?: string;
    category?: string;
    minPrice?: number;
    maxPrice?: number;
  }): Promise<ToolResult> => {
    let products = loadProducts();

    if (params.keyword) {
      const kw = params.keyword.toLowerCase();
      products = products.filter(
        (p: any) =>
          p.name.toLowerCase().includes(kw) ||
          p.description.toLowerCase().includes(kw)
      );
    }

    if (params.category) {
      products = products.filter(
        (p: any) => p.category === params.category
      );
    }

    if (params.minPrice !== undefined) {
      products = products.filter((p: any) => p.price >= params.minPrice!);
    }

    if (params.maxPrice !== undefined) {
      products = products.filter((p: any) => p.price <= params.maxPrice!);
    }

    products = products.slice(0, 5);

    if (products.length === 0) {
      return { content: '没有找到匹配的商品，请尝试调整搜索条件。', isError: false };
    }

    const formatted = products
      .map(
        (p: any) =>
          `[${p.productId}] ${p.name}\n价格: ¥${p.price} | 分类: ${p.category}\n${p.description}\n库存: ${p.stock > 0 ? '有货' : '缺货'}`
      )
      .join('\n---\n');

    return {
      content: formatted,
      metadata: { count: products.length, productIds: products.map((p: any) => p.id) },
    };
  },
};
