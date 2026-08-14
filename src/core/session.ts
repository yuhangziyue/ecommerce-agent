import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionEntry, Message, ToolCallEntry, ToolResultEntry, MetadataEntry } from './types.js';

const SESSIONS_DIR = path.join(process.cwd(), 'sessions');

function ensureSessionsDir(): void {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

function sessionFilePath(sessionId: string): string {
  return path.join(SESSIONS_DIR, `${sessionId}.jsonl`);
}

export class Session {
  private sessionId: string;
  private filePath: string;
  private entries: SessionEntry[] = [];

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    ensureSessionsDir();
    this.filePath = sessionFilePath(sessionId);
  }

  static create(): Session {
    const id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const session = new Session(id);
    session.appendMetadata('created', { timestamp: Date.now() });
    return session;
  }

  static restore(sessionId: string): Session {
    const session = new Session(sessionId);
    session.loadFromFile();
    return session;
  }

  static list(): string[] {
    ensureSessionsDir();
    return fs
      .readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.replace('.jsonl', ''))
      .sort();
  }

  getId(): string {
    return this.sessionId;
  }

  getEntries(): SessionEntry[] {
    return [...this.entries];
  }

  /**
   * 把完整事件流**投影**成对话消息序列。
   *
   * v0.3 之前这里是 `entries.filter(e => e.type === 'message')` —— 那是**过滤**，
   * 而工具结果走的是 `appendToolResult()` 写入的 `tool_result` entry，被整段漏掉。
   * 后果：落盘序列里有带 `toolUses` 的 assistant 消息，却没有对应的 tool 结果消息，
   * `restore()` 出来的历史因 tool_use 缺少配对的 tool_result 必被 API 拒绝。
   *
   * 投影规则：
   * - `message`     → 原样
   * - `tool_result` → 合成一条 role:'tool' 消息（此前丢失的部分）
   * - `tool_call`   → 跳过（信息已包含在 assistant 消息的 toolUses 里，重复投影会双计）
   * - `metadata`    → 跳过（不是对话内容）
   */
  getMessages(): Message[] {
    const messages: Message[] = [];

    for (const entry of this.entries) {
      if (entry.type === 'message') {
        messages.push(entry.data as Message);
      } else if (entry.type === 'tool_result') {
        const toolResult = entry.data as ToolResultEntry;
        messages.push({
          role: 'tool',
          content: toolResult.result.content,
          toolResult: {
            toolUseId: toolResult.toolUseId,
            result: toolResult.result,
          },
          timestamp: entry.timestamp,
        });
      }
    }

    return messages;
  }

  appendMessage(message: Message): void {
    const entry: SessionEntry = {
      type: 'message',
      data: message,
      timestamp: Date.now(),
    };
    this.entries.push(entry);
    this.appendToFile(entry);
  }

  appendToolCall(toolCall: ToolCallEntry): void {
    const entry: SessionEntry = {
      type: 'tool_call',
      data: toolCall,
      timestamp: Date.now(),
    };
    this.entries.push(entry);
    this.appendToFile(entry);
  }

  appendToolResult(toolResult: ToolResultEntry): void {
    const entry: SessionEntry = {
      type: 'tool_result',
      data: toolResult,
      timestamp: Date.now(),
    };
    this.entries.push(entry);
    this.appendToFile(entry);
  }

  appendMetadata(key: string, value: unknown): void {
    const entry: SessionEntry = {
      type: 'metadata',
      data: { key, value } as MetadataEntry,
      timestamp: Date.now(),
    };
    this.entries.push(entry);
    this.appendToFile(entry);
  }

  private appendToFile(entry: SessionEntry): void {
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(this.filePath, line, 'utf-8');
  }

  private loadFromFile(): void {
    if (!fs.existsSync(this.filePath)) {
      return;
    }

    const content = fs.readFileSync(this.filePath, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim().length > 0);

    this.entries = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as SessionEntry;
        this.entries.push(entry);
      } catch {
        // 崩溃恢复：跳过损坏的最后一行，最多丢失一条记录
        console.warn(`[Session] 跳过损坏的日志行: ${line.slice(0, 80)}...`);
      }
    }
  }
}
