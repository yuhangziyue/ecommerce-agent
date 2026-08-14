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
  toolUse?: ToolUse;
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
  | { type: 'done'; totalTokens: TokenUsage; totalCost: number };
