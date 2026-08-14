import * as fs from 'node:fs';
import * as path from 'node:path';
import { Session } from '../src/core/session.js';
import { messagesToAnthropicFormat } from '../src/core/model-provider.js';
import type { Message, ToolCallEntry, ToolResultEntry } from '../src/core/types.js';

// Session uses process.cwd()/sessions as its storage directory.
// We save and restore cwd so tests write to a temp directory.

const originalCwd = process.cwd();
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join('/tmp', 'session-test-'));
  process.chdir(tmpDir);
});

afterAll(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Session', () => {
  describe('Session.create()', () => {
    it('creates a new session with an ID', () => {
      const session = Session.create();
      const id = session.getId();

      expect(id).toBeTruthy();
      expect(id).toMatch(/^session-/);
    });

    it('creates a metadata entry on creation', () => {
      const session = Session.create();
      const entries = session.getEntries();

      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries[0].type).toBe('metadata');
    });
  });

  describe('appendMessage() and getMessages()', () => {
    it('stores and retrieves messages', () => {
      const session = Session.create();
      const msg: Message = {
        role: 'user',
        content: 'Hello',
        timestamp: Date.now(),
      };

      session.appendMessage(msg);
      const messages = session.getMessages();

      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toBe('Hello');
    });

    it('returns messages in order', () => {
      const session = Session.create();

      session.appendMessage({ role: 'user', content: 'Hi', timestamp: Date.now() });
      session.appendMessage({ role: 'assistant', content: 'Hello!', timestamp: Date.now() });

      const messages = session.getMessages();
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('user');
      expect(messages[1].role).toBe('assistant');
    });
  });

  describe('appendToolCall() and appendToolResult()', () => {
    it('appends tool call entries', () => {
      const session = Session.create();
      const toolCall: ToolCallEntry = {
        toolUseId: 'tc-001',
        toolName: 'queryOrder',
        input: { orderId: 'ORD-001' },
      };

      session.appendToolCall(toolCall);
      const entries = session.getEntries();
      const toolEntries = entries.filter((e) => e.type === 'tool_call');

      expect(toolEntries).toHaveLength(1);
      expect((toolEntries[0].data as ToolCallEntry).toolName).toBe('queryOrder');
    });

    it('appends tool result entries', () => {
      const session = Session.create();
      const toolResult: ToolResultEntry = {
        toolUseId: 'tc-001',
        result: { content: 'Order found', isError: false },
        durationMs: 42,
      };

      session.appendToolResult(toolResult);
      const entries = session.getEntries();
      const resultEntries = entries.filter((e) => e.type === 'tool_result');

      expect(resultEntries).toHaveLength(1);
      expect((resultEntries[0].data as ToolResultEntry).durationMs).toBe(42);
    });
  });

  describe('getEntries()', () => {
    it('returns all entry types', () => {
      const session = Session.create();

      session.appendMessage({ role: 'user', content: 'test', timestamp: Date.now() });
      session.appendToolCall({ toolUseId: 'tc-1', toolName: 'tool', input: {} });
      session.appendToolResult({ toolUseId: 'tc-1', result: { content: 'ok' }, durationMs: 10 });

      const entries = session.getEntries();
      const types = entries.map((e) => e.type);

      expect(types).toContain('metadata');
      expect(types).toContain('message');
      expect(types).toContain('tool_call');
      expect(types).toContain('tool_result');
    });
  });

  describe('Session.restore()', () => {
    it('loads session from file', () => {
      const original = Session.create();
      const id = original.getId();

      original.appendMessage({ role: 'user', content: 'persisted message', timestamp: Date.now() });

      const restored = Session.restore(id);
      const messages = restored.getMessages();

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('persisted message');
    });

    it('restores all entry types', () => {
      const original = Session.create();
      const id = original.getId();

      original.appendMessage({ role: 'user', content: 'hi', timestamp: Date.now() });
      original.appendToolCall({ toolUseId: 'tc-x', toolName: 'search', input: { q: 'test' } });

      const restored = Session.restore(id);
      const entries = restored.getEntries();

      // metadata (from create) + message + tool_call = at least 3
      expect(entries.length).toBeGreaterThanOrEqual(3);
    });
  });
});

// ============ v0.3 新增：事件流投影与 restore 合法性 ============
//
// getMessages() 此前是「过滤 type === 'message'」，工具结果走 tool_result entry 被整段漏掉。
// 后果：restore 出的历史里 assistant 有 toolUses 但没有配对的 tool 结果消息，
// 喂给 Anthropic API 必被拒（tool_use 缺少 tool_result）。
// v0.6 服务化后每个 HTTP 请求都要靠 sessionId 恢复上下文，这个 bug 会从潜伏变成必现。

function seedToolTurn(session: Session): void {
  session.appendMessage({ role: 'user', content: '查订单和商品', timestamp: 1 });
  session.appendMessage({
    role: 'assistant',
    content: '我来查',
    toolUses: [
      { id: 'tu_1', name: 'order_lookup', input: { orderId: 'A' } },
      { id: 'tu_2', name: 'product_search', input: { keyword: 'B' } },
    ],
    timestamp: 2,
  });
  session.appendToolCall({ toolUseId: 'tu_1', toolName: 'order_lookup', input: {} });
  session.appendToolResult({
    toolUseId: 'tu_1',
    result: { content: '订单已发货' },
    durationMs: 5,
  });
  session.appendToolCall({ toolUseId: 'tu_2', toolName: 'product_search', input: {} });
  session.appendToolResult({
    toolUseId: 'tu_2',
    result: { content: '找到 3 件商品' },
    durationMs: 7,
  });
  session.appendMessage({ role: 'assistant', content: '都查到了', timestamp: 3 });
}

describe('Session.getMessages() 事件流投影', () => {
  it('把 tool_result entry 投影为 tool 角色消息（此前整段丢失）', () => {
    const session = Session.create();
    seedToolTurn(session);

    const messages = session.getMessages();

    expect(messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'assistant',
    ]);
    expect(messages[2].toolResult!.toolUseId).toBe('tu_1');
    expect(messages[2].content).toBe('订单已发货');
    expect(messages[3].toolResult!.toolUseId).toBe('tu_2');
  });

  it('tool_call entry 不被重复投影（信息已在 assistant.toolUses 里）', () => {
    const session = Session.create();
    seedToolTurn(session);

    // 2 个 tool_call + 2 个 tool_result，若都投影会得到 4 条 tool 消息
    const toolMsgs = session.getMessages().filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(2);
  });

  it('metadata entry 不进对话历史', () => {
    const session = Session.create(); // create 本身写了一条 metadata
    session.appendMetadata('score', { overall: 0.8 });
    session.appendMessage({ role: 'user', content: 'q', timestamp: 1 });

    expect(session.getMessages()).toHaveLength(1);
  });
});

describe('Session.restore() 恢复后的历史合法性', () => {
  it('每个 tool_use 都有配对的 tool_result（API 合法性不变量）', () => {
    const original = Session.create();
    const id = original.getId();
    seedToolTurn(original);

    const messages = Session.restore(id).getMessages();

    const useIds = messages
      .filter((m) => m.toolUses)
      .flatMap((m) => m.toolUses!.map((t) => t.id));
    const resultIds = messages
      .filter((m) => m.role === 'tool')
      .map((m) => m.toolResult!.toolUseId);

    expect(useIds).toEqual(['tu_1', 'tu_2']);
    expect(resultIds.sort()).toEqual(useIds.sort());
  });

  it('恢复出的历史转成 API 格式后不产生孤立 tool_result', () => {
    const original = Session.create();
    const id = original.getId();
    seedToolTurn(original);

    const wire = messagesToAnthropicFormat(Session.restore(id).getMessages());

    // 首条必须是 user 文本，不能是携带 tool_result 的 user 消息
    expect(wire[0]).toEqual({ role: 'user', content: '查订单和商品' });

    // 两个 tool_result 合并进同一条 user 消息
    const toolResultGroups = wire.filter(
      (m) =>
        Array.isArray(m.content) &&
        (m.content as Array<{ type: string }>)[0]?.type === 'tool_result'
    );
    expect(toolResultGroups).toHaveLength(1);
    expect(toolResultGroups[0].content as unknown[]).toHaveLength(2);
  });

  it('恢复出的历史可直接作为 AgentLoop 的初始上下文（长度与运行时一致）', () => {
    const original = Session.create();
    const id = original.getId();
    seedToolTurn(original);

    expect(Session.restore(id).getMessages()).toHaveLength(
      original.getMessages().length
    );
  });
});
