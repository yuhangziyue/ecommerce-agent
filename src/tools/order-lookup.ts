import { AgentTool, ToolResult } from '../core/types.js';
import { Type } from '@sinclair/typebox';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadOrders(): any[] {
  const dataPath = path.join(__dirname, '..', 'data', 'orders.json');
  return JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
}

export const orderLookupTool: AgentTool = {
  name: 'order_lookup',
  description: '根据订单号或手机号后4位查询订单信息',
  parameters: {
    type: 'object',
    properties: {
      orderId: { type: 'string', description: '订单号，如 ORD-20260801-001' },
      phoneLast4: { type: 'string', description: '手机号后4位' },
    },
    required: [],
  },
  riskLevel: 'low',
  execute: async (params: { orderId?: string; phoneLast4?: string }): Promise<ToolResult> => {
    const orders = loadOrders();
    let results: any[] = [];

    if (params.orderId) {
      results = orders.filter((o: any) => o.orderId === params.orderId);
    } else if (params.phoneLast4) {
      results = orders.filter((o: any) => o.phone.endsWith(params.phoneLast4));
    } else {
      return { content: '请提供订单号或手机号后4位进行查询', isError: true };
    }

    if (results.length === 0) {
      return { content: '未找到匹配的订单，请确认订单号或手机号是否正确。', isError: false };
    }

    const formatted = results.map((o: any) => {
      let info = `订单号: ${o.orderId}\n客户: ${o.customerName}\n商品: ${o.items.map((i: any) => i.name).join(', ')}\n金额: ¥${o.totalAmount}\n状态: ${o.status}`;
      if (o.tracking) {
        info += `\n物流: ${o.tracking.company} ${o.tracking.number}`;
      }
      return info;
    }).join('\n---\n');

    return {
      content: formatted,
      metadata: { count: results.length, orderIds: results.map((o: any) => o.orderId) },
    };
  },
};
