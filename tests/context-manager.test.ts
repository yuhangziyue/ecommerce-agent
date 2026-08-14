import { describe, it, expect } from 'vitest';
import { ContextManager } from '../src/memory/context-manager.js';
import { Message } from '../src/core/types.js';

function makeMessage(role: Message['role'], content: string): Message {
  return { role, content, timestamp: Date.now() };
}

describe('ContextManager', () => {
  it('defaults maxMessages to 20', () => {
    const cm = new ContextManager();
    const messages = Array.from({ length: 20 }, (_, i) => makeMessage('user', `msg${i}`));
    expect(cm.trimMessages(messages)).toHaveLength(20);
  });

  it('returns messages as-is when under the limit', () => {
    const cm = new ContextManager(5);
    const messages = [
      makeMessage('user', 'hello'),
      makeMessage('assistant', 'hi'),
    ];
    expect(cm.trimMessages(messages)).toEqual(messages);
  });

  it('returns messages as-is when exactly at the limit', () => {
    const cm = new ContextManager(3);
    const messages = [
      makeMessage('user', 'a'),
      makeMessage('assistant', 'b'),
      makeMessage('user', 'c'),
    ];
    expect(cm.trimMessages(messages)).toEqual(messages);
  });

  it('preserves system messages and trims oldest non-system messages when over limit', () => {
    const cm = new ContextManager(4);
    const sys = makeMessage('system', 'you are a bot');
    const messages: Message[] = [
      sys,
      makeMessage('user', 'old1'),
      makeMessage('assistant', 'old2'),
      makeMessage('user', 'recent1'),
      makeMessage('assistant', 'recent2'),
      makeMessage('user', 'recent3'),
    ];

    const trimmed = cm.trimMessages(messages);

    // system message always kept
    expect(trimmed[0]).toBe(sys);
    // total length respects maxMessages
    expect(trimmed).toHaveLength(4);
    // oldest non-system messages dropped; newest kept
    expect(trimmed.map(m => m.content)).toEqual([
      'you are a bot',
      'recent1',
      'recent2',
      'recent3',
    ]);
  });

  it('preserves multiple system messages when trimming', () => {
    const cm = new ContextManager(5);
    const sys1 = makeMessage('system', 'system1');
    const sys2 = makeMessage('system', 'system2');
    const messages: Message[] = [
      sys1,
      sys2,
      makeMessage('user', 'u1'),
      makeMessage('assistant', 'a1'),
      makeMessage('user', 'u2'),
      makeMessage('assistant', 'a2'),
      makeMessage('user', 'u3'),
    ];

    const trimmed = cm.trimMessages(messages);

    expect(trimmed).toHaveLength(5);
    // both system messages preserved at start
    expect(trimmed[0]).toBe(sys1);
    expect(trimmed[1]).toBe(sys2);
    // remaining slots filled with most recent non-system
    expect(trimmed.map(m => m.content)).toEqual([
      'system1',
      'system2',
      'u2',
      'a2',
      'u3',
    ]);
    // 3 non-system slots (5 - 2 system)
    expect(trimmed.filter(m => m.role !== 'system')).toHaveLength(3);
  });

  it('handles all-system messages without crashing', () => {
    const cm = new ContextManager(2);
    const messages = [
      makeMessage('system', 's1'),
      makeMessage('system', 's2'),
      makeMessage('system', 's3'),
    ];
    const trimmed = cm.trimMessages(messages);
    // all system preserved, no non-system to trim
    expect(trimmed.filter(m => m.role === 'system')).toHaveLength(3);
  });
});
