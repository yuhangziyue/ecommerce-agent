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

  getMessages(): Message[] {
    return this.entries
      .filter((e) => e.type === 'message')
      .map((e) => e.data as Message);
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
