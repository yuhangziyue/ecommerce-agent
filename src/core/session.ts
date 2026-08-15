import type {
  Message,
  SessionEntry,
  ToolCallEntry,
  ToolResultEntry,
  MetadataEntry,
  SummaryEntry,
} from './types.js';

import type {
  CreateSessionInput,
  SessionRecord,
  SessionStore,
} from '../store/types.js';

/** 摘要注入对话时的框定文字 —— 让模型知道这是压缩过的历史而不是客户说的话 */
export const SUMMARY_PREFIX = '[以下是本次会话早前内容的摘要，用于保持上下文连贯]\n';

/**
 * 一次会话的读写门面。
 *
 * v0.5 从「JSONL 文件同步追加」改为「走 SessionStore 异步写入」。
 * 写入必须异步 —— 数据库写不可能同步，而假装同步（写后台队列）会丢掉
 * 「写成功才返回」这个持久性保证，恰恰是 v0.6 服务化最需要的。
 *
 * 读取仍是同步的：`getEntries()` / `getMessages()` 走内存缓存。
 * AgentLoop 在每轮里高频读历史，每次打库不现实；缓存在创建/恢复时装载，
 * 之后每次写入同步追加到缓存，与库保持一致。
 */
export class Session {
  private constructor(
    private readonly record: SessionRecord,
    private readonly store: SessionStore,
    private entries: SessionEntry[]
  ) {}

  static async create(
    store: SessionStore,
    input: CreateSessionInput = {}
  ): Promise<Session> {
    const record = await store.create(input);
    const session = new Session(record, store, []);
    await session.appendMetadata('created', { timestamp: record.createdAt });
    return session;
  }

  /** 会话不存在返回 null —— 服务化后这是常见路径（客户端传了过期/伪造的 sessionId） */
  static async restore(store: SessionStore, id: string): Promise<Session | null> {
    const record = await store.get(id);
    if (!record) return null;
    const entries = await store.getEntries(id);
    return new Session(record, store, entries);
  }

  getId(): string {
    return this.record.id;
  }

  getUserId(): string | null {
    return this.record.userId;
  }

  getTenantId(): string | null {
    return this.record.tenantId;
  }

  getEntries(): SessionEntry[] {
    return [...this.entries];
  }

  /**
   * 把完整事件流**投影**成对话消息序列（v0.3 的成果，逻辑原样保留）。
   *
   * 投影规则：
   * - `message`     → 原样
   * - `tool_result` → 合成一条 role:'tool' 消息（v0.3 之前这段被整体漏掉，
   *                   导致 restore 出的历史因 tool_use 缺配对被 API 拒绝）
   * - `summary`     → 投影成带框定前缀的 user 消息（v0.7 中期记忆）
   * - `tool_call`   → 跳过（信息已在 assistant 消息的 toolUses 里，重复投影会双计）
   * - `metadata`    → 跳过（不是对话内容）
   *
   * 摘要用 `user` 角色而非 `system`：`messagesToAnthropicFormat` 会跳过 system 消息
   *（它们走顶层 system 参数），做成 system 摘要就永远到不了模型。
   */
  getMessages(): Message[] {
    const messages: Message[] = [];

    for (const entry of this.entries) {
      if (entry.type === 'message') {
        messages.push(entry.data as Message);
      } else if (entry.type === 'summary') {
        const summary = entry.data as SummaryEntry;
        // 摘要**吸收**它之前的 N 条已投影消息，而不是追加在后面 ——
        // 只追加的话历史只会变长，中期记忆就成了纯粹的负担。
        messages.splice(0, summary.compactedCount);
        messages.unshift({
          role: 'user',
          content: `${SUMMARY_PREFIX}${summary.content}`,
          timestamp: entry.timestamp,
        });
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

  appendMessage(message: Message): Promise<void> {
    return this.append('message', message);
  }

  appendToolCall(toolCall: ToolCallEntry): Promise<void> {
    return this.append('tool_call', toolCall);
  }

  appendToolResult(toolResult: ToolResultEntry): Promise<void> {
    return this.append('tool_result', toolResult);
  }

  appendMetadata(key: string, value: unknown): Promise<void> {
    return this.append('metadata', { key, value } as MetadataEntry);
  }

  /** 追加一条中期记忆摘要（v0.7）。落 session 才能 restore，也才可审计。 */
  appendSummary(summary: SummaryEntry): Promise<void> {
    return this.append('summary', summary);
  }

  private async append(
    type: SessionEntry['type'],
    data: SessionEntry['data']
  ): Promise<void> {
    const entry: SessionEntry = { type, data, timestamp: Date.now() };
    await this.store.appendEntry(this.record.id, entry);
    this.entries.push(entry);
  }
}
