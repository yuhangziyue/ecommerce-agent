// ToolResult - 工具返回
export interface ToolResult {
  content: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

// AgentTool - 工具定义（泛型，带TypeBox schema）
export interface AgentTool<T = any> {
  name: string;
  description: string;
  parameters: T; // TypeBox schema
  riskLevel: 'low' | 'medium' | 'high';
  execute: (params: any) => Promise<ToolResult>;
}

// Message types
export type Role = 'user' | 'assistant' | 'system' | 'tool';

export interface Message {
  role: Role;
  content: string;
  /**
   * 一个 assistant 轮次可以发起**多个**工具调用（Claude 默认开启 parallel tool use）。
   * v0.3 从单数 `toolUse` 改为复数：此前只保留最后一个，其余静默丢弃，
   * 导致下一轮请求因 tool_use 缺少配对的 tool_result 被 API 拒绝，整轮对话中断。
   */
  toolUses?: ToolUse[];
  toolResult?: { toolUseId: string; result: ToolResult };
  timestamp: number;
}

export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// Session
export interface SessionEntry {
  type: 'message' | 'tool_call' | 'tool_result' | 'metadata';
  data: Message | ToolCallEntry | ToolResultEntry | MetadataEntry;
  timestamp: number;
}

export interface ToolCallEntry {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ToolResultEntry {
  toolUseId: string;
  result: ToolResult;
  durationMs: number;
}

export interface MetadataEntry {
  key: string;
  value: unknown;
}

// Token tracking
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface CostRecord {
  usage: TokenUsage;
  costUsd: number;
  model: string;
  timestamp: number;
}

// Agent config
export interface AgentConfig {
  model: string;
  apiKey?: string;
  maxTurns: number;
  maxTokensPerSession: number;
  systemPrompt: string;
  confirmHighRisk: boolean;
}

// Agent events (流式事件)
export type AgentEvent =
  | { type: 'thinking'; content: string }
  | { type: 'tool_start'; toolName: string; input: Record<string, unknown> }
  | { type: 'tool_end'; toolName: string; result: ToolResult; durationMs: number }
  | { type: 'response'; content: string }
  | { type: 'error'; error: string }
  /** 被中间件拦截（注入检测 / 预算熔断 / 后续版本的合规与配额）；by 为中间件名 */
  | { type: 'blocked'; by: string; reason: string }
  | { type: 'done'; totalTokens: TokenUsage; totalCost: number };

// ============ 模型调用抽象 ============

/** 一次模型调用的归一化结果，屏蔽具体 SDK 的响应形态 */
export interface ChatResponse {
  content: string;
  /** 恒为数组（可能为空），不用可选字段 —— 避免调用方漏判 undefined 而丢块 */
  toolUses: ToolUse[];
  usage: TokenUsage;
  stopReason: string;
}

/**
 * 模型提供方接口。
 *
 * AgentLoop 依赖此接口而非 ModelProvider 具体类 —— 这样测试可以注入脚本化的假实现，
 * 从而覆盖「循环终止 / 预算熔断 / 确认拒绝 / 工具报错回喂」这些不发真实请求就测不到的路径。
 */
export interface ChatProvider {
  chat(
    systemPrompt: string,
    messages: Message[],
    tools: AgentTool[]
  ): Promise<ChatResponse>;
  getModel(): string;
}
