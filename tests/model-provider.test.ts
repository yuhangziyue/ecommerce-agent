import {
  messagesToAnthropicFormat,
  toolToAnthropicSchema,
  parseAnthropicResponse,
} from '../src/core/model-provider.js';
import type { Message } from '../src/core/types.js';
import { orderLookupTool } from '../src/tools/order-lookup.js';

describe('parseAnthropicResponse', () => {
  const usage = { input_tokens: 10, output_tokens: 5 };

  it('纯文本响应', () => {
    const parsed = parseAnthropicResponse({
      content: [{ type: 'text', text: '您好' }],
      usage,
      stop_reason: 'end_turn',
    } as never);
    expect(parsed.content).toBe('您好');
    expect(parsed.toolUses).toEqual([]);
    expect(parsed.stopReason).toBe('end_turn');
  });

  it('多个 tool_use 块全部被收集（v0.3 修复：此前后者覆盖前者，只剩最后一个）', () => {
    const parsed = parseAnthropicResponse({
      content: [
        { type: 'text', text: '我来查两样' },
        { type: 'tool_use', id: 'tu_1', name: 'order_lookup', input: { orderId: 'A' } },
        { type: 'tool_use', id: 'tu_2', name: 'product_search', input: { keyword: 'B' } },
        { type: 'tool_use', id: 'tu_3', name: 'faq_search', input: { query: 'C' } },
      ],
      usage,
      stop_reason: 'tool_use',
    } as never);

    expect(parsed.toolUses.map((t) => t.id)).toEqual(['tu_1', 'tu_2', 'tu_3']);
    expect(parsed.toolUses.map((t) => t.name)).toEqual([
      'order_lookup',
      'product_search',
      'faq_search',
    ]);
    expect(parsed.content).toBe('我来查两样');
  });

  it('usage 与缓存字段被透传', () => {
    const parsed = parseAnthropicResponse({
      content: [],
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 10,
      },
      stop_reason: 'end_turn',
    } as never);
    expect(parsed.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
    });
  });
});

describe('messagesToAnthropicFormat', () => {
  it('user 消息原样转为字符串内容', () => {
    const out = messagesToAnthropicFormat([
      { role: 'user', content: '查订单', timestamp: 1 },
    ]);
    expect(out).toEqual([{ role: 'user', content: '查订单' }]);
  });

  it('assistant 带 toolUses 时产出 tool_use 块，且无空 text 块', () => {
    const out = messagesToAnthropicFormat([
      {
        role: 'assistant',
        content: '',
        toolUses: [{ id: 'tu_1', name: 'order_lookup', input: { orderId: 'A' } }],
        timestamp: 1,
      },
    ]);
    const blocks = out[0].content as unknown[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'tool_use',
      id: 'tu_1',
      name: 'order_lookup',
    });
  });

  it('assistant 同时有文本和 toolUses 时产出 text + tool_use', () => {
    const out = messagesToAnthropicFormat([
      {
        role: 'assistant',
        content: '我来查一下',
        toolUses: [{ id: 'tu_1', name: 'order_lookup', input: {} }],
        timestamp: 1,
      },
    ]);
    const blocks = out[0].content as Array<{ type: string }>;
    expect(blocks.map((b) => b.type)).toEqual(['text', 'tool_use']);
  });

  it('assistant 的多个 toolUses 全部转为 tool_use 块并保序', () => {
    const out = messagesToAnthropicFormat([
      {
        role: 'assistant',
        content: '',
        toolUses: [
          { id: 'tu_1', name: 'a', input: {} },
          { id: 'tu_2', name: 'b', input: {} },
        ],
        timestamp: 1,
      },
    ]);
    const blocks = out[0].content as Array<{ type: string; id: string }>;
    expect(blocks.map((b) => b.id)).toEqual(['tu_1', 'tu_2']);
  });

  it('tool 角色消息转为带 tool_result 的 user 消息（API 要求的配对形态）', () => {
    const msgs: Message[] = [
      { role: 'user', content: '查订单', timestamp: 1 },
      {
        role: 'assistant',
        content: '',
        toolUses: [{ id: 'tu_1', name: 'order_lookup', input: {} }],
        timestamp: 2,
      },
      {
        role: 'tool',
        content: '订单已发货',
        toolResult: { toolUseId: 'tu_1', result: { content: '订单已发货' } },
        timestamp: 3,
      },
    ];
    const out = messagesToAnthropicFormat(msgs);
    expect(out).toHaveLength(3);
    expect(out[2].role).toBe('user');
    expect((out[2].content as unknown[])[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: '订单已发货',
    });
  });

  it('v0.3 关键：连续的 tool 消息合并成一条 user 消息', () => {
    // 拆成多条 user 消息发出会训练模型停止做并行调用 —— 性能收益被自己作废
    const out = messagesToAnthropicFormat([
      { role: 'user', content: 'q', timestamp: 1 },
      {
        role: 'assistant',
        content: '',
        toolUses: [
          { id: 'tu_1', name: 'a', input: {} },
          { id: 'tu_2', name: 'b', input: {} },
        ],
        timestamp: 2,
      },
      {
        role: 'tool',
        content: 'r1',
        toolResult: { toolUseId: 'tu_1', result: { content: 'r1' } },
        timestamp: 3,
      },
      {
        role: 'tool',
        content: 'r2',
        toolResult: { toolUseId: 'tu_2', result: { content: 'r2' } },
        timestamp: 4,
      },
    ]);

    expect(out).toHaveLength(3); // user / assistant / user(合并两个结果)
    expect(out[1].content as unknown[]).toHaveLength(2); // 2×tool_use
    const merged = out[2].content as Array<{ type: string; tool_use_id: string }>;
    expect(merged).toHaveLength(2);
    expect(merged.map((b) => b.tool_use_id)).toEqual(['tu_1', 'tu_2']);
  });

  it('多轮的 tool 结果各自成组，不跨轮合并', () => {
    const out = messagesToAnthropicFormat([
      { role: 'user', content: 'q1', timestamp: 1 },
      {
        role: 'assistant',
        content: '',
        toolUses: [{ id: 'tu_1', name: 'a', input: {} }],
        timestamp: 2,
      },
      {
        role: 'tool',
        content: 'r1',
        toolResult: { toolUseId: 'tu_1', result: { content: 'r1' } },
        timestamp: 3,
      },
      { role: 'assistant', content: '好了', timestamp: 4 },
      { role: 'user', content: 'q2', timestamp: 5 },
      {
        role: 'assistant',
        content: '',
        toolUses: [{ id: 'tu_2', name: 'b', input: {} }],
        timestamp: 6,
      },
      {
        role: 'tool',
        content: 'r2',
        toolResult: { toolUseId: 'tu_2', result: { content: 'r2' } },
        timestamp: 7,
      },
    ]);

    const toolResultGroups = out.filter(
      (m) =>
        Array.isArray(m.content) &&
        (m.content as Array<{ type: string }>)[0]?.type === 'tool_result'
    );
    expect(toolResultGroups).toHaveLength(2);
    expect(toolResultGroups.every((g) => (g.content as unknown[]).length === 1)).toBe(
      true
    );
  });

  it('工具报错时 tool_result 携带 is_error', () => {
    const out = messagesToAnthropicFormat([
      {
        role: 'tool',
        content: '参数校验失败',
        toolResult: {
          toolUseId: 'tu_1',
          result: { content: '参数校验失败', isError: true },
        },
        timestamp: 1,
      },
    ]);
    expect((out[0].content as unknown[])[0]).toMatchObject({ is_error: true });
  });

  it('缺少 toolResult 的 tool 消息被丢弃（避免发出非法配对）', () => {
    const out = messagesToAnthropicFormat([
      { role: 'user', content: 'q', timestamp: 1 },
      { role: 'tool', content: '孤立结果', timestamp: 2 },
    ]);
    expect(out).toHaveLength(1);
  });
});

describe('toolToAnthropicSchema', () => {
  it('把 TypeBox schema 转为 input_schema，且顶层 type 恒为 object', () => {
    const schema = toolToAnthropicSchema(orderLookupTool as never);
    expect(schema.name).toBe('order_lookup');
    expect(schema.description).toContain('订单');
    expect(schema.input_schema.type).toBe('object');
    expect(Object.keys(schema.input_schema.properties as object)).toEqual(
      expect.arrayContaining(['orderId', 'phoneLast4'])
    );
  });

  it('转换结果可被 JSON 序列化（TypeBox 的 Symbol 键不会泄漏到 wire 上）', () => {
    const schema = toolToAnthropicSchema(orderLookupTool as never);
    const roundTrip = JSON.parse(JSON.stringify(schema));
    expect(roundTrip.input_schema.properties.orderId.type).toBe('string');
  });
});
