import {
  messagesToAnthropicFormat,
  toolToAnthropicSchema,
} from '../src/core/model-provider.js';
import type { Message } from '../src/core/types.js';
import { orderLookupTool } from '../src/tools/order-lookup.js';

describe('messagesToAnthropicFormat', () => {
  it('user 消息原样转为字符串内容', () => {
    const out = messagesToAnthropicFormat([
      { role: 'user', content: '查订单', timestamp: 1 },
    ]);
    expect(out).toEqual([{ role: 'user', content: '查订单' }]);
  });

  it('assistant 带 toolUse 时产出 tool_use 块，且无空 text 块', () => {
    const out = messagesToAnthropicFormat([
      {
        role: 'assistant',
        content: '',
        toolUse: { id: 'tu_1', name: 'order_lookup', input: { orderId: 'A' } },
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

  it('assistant 同时有文本和 toolUse 时产出 text + tool_use 两块', () => {
    const out = messagesToAnthropicFormat([
      {
        role: 'assistant',
        content: '我来查一下',
        toolUse: { id: 'tu_1', name: 'order_lookup', input: {} },
        timestamp: 1,
      },
    ]);
    const blocks = out[0].content as Array<{ type: string }>;
    expect(blocks.map((b) => b.type)).toEqual(['text', 'tool_use']);
  });

  it('tool 角色消息转为带 tool_result 的 user 消息（API 要求的配对形态）', () => {
    const msgs: Message[] = [
      { role: 'user', content: '查订单', timestamp: 1 },
      {
        role: 'assistant',
        content: '',
        toolUse: { id: 'tu_1', name: 'order_lookup', input: {} },
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
