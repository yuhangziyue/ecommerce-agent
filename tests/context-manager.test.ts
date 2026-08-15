import { describe, it, expect } from 'vitest';
import { ContextManager } from '../src/memory/context-manager.js';
import { Message } from '../src/core/types.js';

function makeMessage(role: Message['role'], content: string): Message {
  return { role, content, timestamp: Date.now() };
}

// ============ v0.2 新增：配对感知裁剪 ============
//
// trimMessages 按固定窗口盲切，切点可能落在 assistant(tool_use) 与其 tool_result 之间。
// 那样喂给 Anthropic API 会因缺少配对被拒（tool_result 没有对应的 tool_use）。
// trimSafely 把切点前/后推到真正的「用户轮次边界」，保证永不产生孤儿。

function toolUseMsg(id: string): Message {
  return {
    role: 'assistant',
    content: '',
    toolUses: [{ id, name: 'order_lookup', input: {} }],
    timestamp: Date.now(),
  };
}

function toolResultMsg(id: string, content: string): Message {
  return {
    role: 'tool',
    content,
    toolResult: { toolUseId: id, result: { content } },
    timestamp: Date.now(),
  };
}

describe('ContextManager.trimSafely', () => {
  it('未超限时原样返回', () => {
    const cm = new ContextManager(5);
    const messages = [makeMessage('user', 'a'), makeMessage('assistant', 'b')];
    expect(cm.trimSafely(messages)).toEqual(messages);
  });

  it('不会把 tool_use 与 tool_result 切散（切点向后推到下一个用户轮次）', () => {
    const cm = new ContextManager(4);
    const messages: Message[] = [
      makeMessage('user', 'q1'),
      toolUseMsg('tu_1'),
      toolResultMsg('tu_1', 'r1'),
      makeMessage('assistant', 'a1'),
      makeMessage('user', 'q2'),
      makeMessage('assistant', 'a2'),
    ];

    const out = cm.trimSafely(messages);

    // 盲切会落在 index 2（tool 消息）上，产生孤立 tool_result
    expect(out[0].role).toBe('user');
    expect(out.find(m => m.role === 'tool')).toBeUndefined();
    expect(out.map(m => m.content)).toEqual(['q2', 'a2']);
  });

  it('无法向后找到边界时，向前回退到最近的用户轮次（宁多留不切散）', () => {
    const cm = new ContextManager(2);
    const messages: Message[] = [
      makeMessage('user', 'q1'),
      toolUseMsg('tu_1'),
      toolResultMsg('tu_1', 'r1'),
    ];

    const out = cm.trimSafely(messages);

    expect(out[0].role).toBe('user');
    // 整轮完整保留：tool_use 与 tool_result 仍成对
    expect(out).toHaveLength(3);
    expect(out[1].toolUses![0].id).toBe('tu_1');
    expect(out[2].toolResult!.toolUseId).toBe('tu_1');
  });

  it('system 消息始终保留在最前', () => {
    const cm = new ContextManager(3);
    const sys = makeMessage('system', 'you are a bot');
    const messages: Message[] = [
      sys,
      makeMessage('user', 'q1'),
      makeMessage('assistant', 'a1'),
      makeMessage('user', 'q2'),
      makeMessage('assistant', 'a2'),
    ];

    const out = cm.trimSafely(messages);

    expect(out[0]).toBe(sys);
    expect(out[1].role).toBe('user');
  });

  it('每条保留下来的 tool 消息都有对应的 tool_use（不变量断言）', () => {
    const cm = new ContextManager(5);
    const messages: Message[] = [
      makeMessage('user', 'q1'),
      toolUseMsg('tu_1'),
      toolResultMsg('tu_1', 'r1'),
      makeMessage('assistant', 'a1'),
      makeMessage('user', 'q2'),
      toolUseMsg('tu_2'),
      toolResultMsg('tu_2', 'r2'),
      makeMessage('assistant', 'a2'),
      makeMessage('user', 'q3'),
    ];

    const out = cm.trimSafely(messages);

    const useIds = new Set(
      out.filter(m => m.toolUses).flatMap(m => m.toolUses!.map(t => t.id))
    );
    for (const m of out.filter(m => m.role === 'tool')) {
      expect(useIds.has(m.toolResult!.toolUseId)).toBe(true);
    }
  });
});
