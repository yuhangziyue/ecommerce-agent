import * as fs from 'node:fs';
import * as path from 'node:path';
import { Session } from '../src/core/session.js';
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
