import * as readline from 'node:readline';
import { Type } from '@sinclair/typebox';
import { AgentLoop, type EventHandler, type ConfirmHandler } from './core/agent-loop.js';
import { Session } from './core/session.js';
import { SYSTEM_PROMPT } from './prompts/system-prompt.js';
import type { AgentConfig, AgentTool, ToolResult } from './core/types.js';
import type { TSchema } from '@sinclair/typebox';

// ============ 加载模拟数据 ============
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const orders: any[] = require('./data/orders.json');
const products: any[] = require('./data/products.json');
const faqs: any[] = require('./data/faqs.json');

// ============ 工具定义 ============

const queryOrderTool: AgentTool<TSchema> = {
  name: 'query_order',
  description: '通过订单号或手机号查询订单信息，包括状态、物流、金额等',
  parameters: Type.Object({
    orderId: Type.Optional(Type.String({ description: '订单号，如 ORD-20260801-001' })),
    phone: Type.Optional(Type.String({ description: '下单手机号' })),
  }),
  riskLevel: 'low',
  async execute(params: { orderId?: string; phone?: string }): Promise<ToolResult> {
    const { orderId, phone } = params;
    if (!orderId && !phone) {
      return { content: '请提供订单号或手机号来查询订单。', isError: true };
    }

    const found = orders.filter(
      (o) =>
        (orderId && o.orderId === orderId) ||
        (phone && o.phone === phone)
    );

    if (found.length === 0) {
      return { content: '未找到匹配的订单，请确认订单号或手机号是否正确。' };
    }

    const statusMap: Record<string, string> = {
      pending: '待付款',
      paid: '已付款，待发货',
      shipped: '已发货，运输中',
      delivered: '已签收',
      refunded: '已退款',
      cancelled: '已取消',
    };

    const details = found
      .map((o) => {
        const items = o.items.map((i: any) => `${i.name} x${i.quantity} (¥${i.price})`).join('、');
        let info = `订单号: ${o.orderId}\n客户: ${o.customerName}\n商品: ${items}\n总金额: ¥${o.totalAmount}\n状态: ${statusMap[o.status] || o.status}\n下单时间: ${o.createTime}`;
        if (o.tracking) {
          info += `\n物流: ${o.tracking.company} ${o.tracking.number}`;
        }
        return info;
      })
      .join('\n---\n');

    return { content: details, metadata: { count: found.length } };
  },
};

const searchProductsTool: AgentTool<TSchema> = {
  name: 'search_products',
  description: '搜索商品，支持按关键词和类别筛选',
  parameters: Type.Object({
    keyword: Type.Optional(Type.String({ description: '搜索关键词' })),
    category: Type.Optional(
      Type.String({
        description: '商品类别：电子产品、服饰、食品',
        enum: ['电子产品', '服饰', '食品'],
      })
    ),
  }),
  riskLevel: 'low',
  async execute(params: { keyword?: string; category?: string }): Promise<ToolResult> {
    const { keyword, category } = params;
    let results = [...products];

    if (category) {
      results = results.filter((p) => p.category === category);
    }

    if (keyword) {
      const kw = keyword.toLowerCase();
      results = results.filter(
        (p) =>
          p.name.toLowerCase().includes(kw) ||
          p.description.toLowerCase().includes(kw)
      );
    }

    if (results.length === 0) {
      return { content: '没有找到匹配的商品，请尝试其他关键词或类别。' };
    }

    const list = results
      .map(
        (p) =>
          `${p.name} | ¥${p.price} | 库存${p.stock} | 评分${p.rating} | ${p.description}`
      )
      .join('\n');

    return {
      content: `找到${results.length}件商品:\n${list}`,
      metadata: { count: results.length },
    };
  },
};

const searchFaqTool: AgentTool<TSchema> = {
  name: 'search_faq',
  description: '搜索常见问题解答',
  parameters: Type.Object({
    keyword: Type.String({ description: '搜索关键词，如退货、配送、支付、会员、发票、优惠券等' }),
  }),
  riskLevel: 'low',
  async execute(params: { keyword: string }): Promise<ToolResult> {
    const kw = params.keyword.toLowerCase();
    const results = faqs.filter(
      (f) =>
        f.question.toLowerCase().includes(kw) ||
        f.answer.toLowerCase().includes(kw) ||
        f.category.toLowerCase().includes(kw)
    );

    if (results.length === 0) {
      return { content: '没有找到相关的常见问题，建议联系人工客服：400-888-0000。' };
    }

    const list = results
      .map((f) => `Q: ${f.question}\nA: ${f.answer}`)
      .join('\n---\n');

    return { content: list, metadata: { count: results.length } };
  },
};

const applyRefundTool: AgentTool<TSchema> = {
  name: 'apply_refund',
  description: '为指定订单申请退款（高风险操作，需要用户确认）',
  parameters: Type.Object({
    orderId: Type.String({ description: '要退款的订单号' }),
    reason: Type.String({ description: '退款原因' }),
  }),
  riskLevel: 'high',
  async execute(params: { orderId: string; reason: string }): Promise<ToolResult> {
    const order = orders.find((o) => o.orderId === params.orderId);
    if (!order) {
      return { content: `未找到订单 ${params.orderId}，请确认订单号是否正确。`, isError: true };
    }

    if (order.status === 'refunded') {
      return { content: `订单 ${params.orderId} 已经退款，无需重复操作。` };
    }

    if (order.status === 'pending') {
      return { content: `订单 ${params.orderId} 尚未付款，无需退款，可直接取消订单。` };
    }

    // 模拟退款成功
    order.status = 'refunded';
    return {
      content: `退款申请已提交！\n订单号: ${params.orderId}\n退款金额: ¥${order.totalAmount}\n退款原因: ${params.reason}\n预计1-7个工作日内原路返回到支付账户。`,
      metadata: { orderId: params.orderId, amount: order.totalAmount },
    };
  },
};

// ============ 主程序 ============

async function main() {
  const config: AgentConfig = {
    model: process.env.AGENT_MODEL || 'claude-sonnet-4-20250514',
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxTurns: 10,
    maxTokensPerSession: 100_000,
    systemPrompt: SYSTEM_PROMPT,
    confirmHighRisk: true,
  };

  if (!config.apiKey) {
    console.error('请设置环境变量 ANTHROPIC_API_KEY');
    process.exit(1);
  }

  const tools: AgentTool<TSchema>[] = [
    queryOrderTool,
    searchProductsTool,
    searchFaqTool,
    applyRefundTool,
  ];

  const session = Session.create();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (query: string): Promise<string> =>
    new Promise((resolve) => rl.question(query, resolve));

  // 事件处理
  const onEvent: EventHandler = (event) => {
    switch (event.type) {
      case 'thinking':
        console.log(`\n💭 ${event.content}`);
        break;
      case 'tool_start':
        console.log(`\n🔧 调用工具: ${event.toolName}`);
        break;
      case 'tool_end':
        console.log(`   ✅ 工具完成 (${event.durationMs}ms)`);
        break;
      case 'response':
        console.log(`\n🤖 ${event.content}`);
        break;
      case 'error':
        console.log(`\n❌ ${event.error}`);
        break;
      case 'done':
        // 静默，退出时打印汇总
        break;
    }
  };

  // 高风险确认
  const onConfirm: ConfirmHandler = async (toolName, input) => {
    console.log(`\n⚠️  高风险操作确认`);
    console.log(`   工具: ${toolName}`);
    console.log(`   参数: ${JSON.stringify(input, null, 2)}`);
    const answer = await prompt('   是否继续？(y/n): ');
    return answer.trim().toLowerCase() === 'y';
  };

  const agent = new AgentLoop(config, tools, session, onEvent, onConfirm);

  console.log('================================================');
  console.log('  好买电商 AI 客服');
  console.log('  输入您的问题，输入 exit 或 quit 退出');
  console.log(`  会话ID: ${session.getId()}`);
  console.log('================================================\n');

  while (true) {
    const input = await prompt('👤 您: ');
    const trimmed = input.trim();

    if (!trimmed) continue;
    if (trimmed === 'exit' || trimmed === 'quit') break;

    await agent.run(trimmed);
  }

  // 打印汇总
  const summary = agent.getTracker().getSummary();
  console.log('\n================================================');
  console.log('  会话结束，Token 和成本汇总');
  console.log('================================================');
  console.log(`  输入 tokens:  ${summary.totalInputTokens.toLocaleString()}`);
  console.log(`  输出 tokens:  ${summary.totalOutputTokens.toLocaleString()}`);
  console.log(`  总 tokens:    ${summary.totalTokens.toLocaleString()}`);
  console.log(`  API 调用次数: ${summary.callCount}`);
  console.log(`  总成本:       $${summary.totalCostUsd.toFixed(4)}`);
  if (summary.cacheReadTokens > 0) {
    console.log(`  缓存读取:     ${summary.cacheReadTokens.toLocaleString()} tokens`);
  }
  console.log('================================================\n');

  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
