// ToolResult - 工具返回
export interface ToolResult {
  /** 给**模型**看的自然语言。模型据此组织回复 */
  content: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
  /**
   * 给**调用方**看的结构化数据（v0.13）。
   *
   * 可选：不产出的工具行为不变。产出的会直接流到 SSE 与响应体，
   * **不经过模型** —— 所以模型换个说法不会让调用方的解析崩掉。
   */
  artifact?: ToolArtifact;
}

/**
 * 工具执行上下文（v0.12）。
 *
 * 为什么不用模块级变量存 sessionId：服务端并发处理多个请求，
 * 模块级的「当前会话」会被后来的请求覆盖 —— 表现为**甲客户的退货记到乙客户名下**，
 * 且只在有并发时出现，本地单请求测试永远发现不了。
 */
export interface ToolContext {
  sessionId: string;
  userId?: string | null;
  tenantId?: string | null;
  /** v0.15：跨进程链路号。工具服务打日志时带上它，一次对话的动作才串得起来 */
  traceId?: string;
  /**
   * v1.2：调用方那一侧的 span id，用来串 `traceparent`。
   * 有它，工具服务里的 span 才能挂到编排层的 span 下面。
   */
  spanId?: string;
  /** v1.0：取消信号。客户端断开后工具不该继续跑 */
  signal?: AbortSignal;
}

// AgentTool - 工具定义（泛型，带TypeBox schema）
export interface AgentTool<T = any> {
  name: string;
  description: string;
  parameters: T; // TypeBox schema
  riskLevel: 'low' | 'medium' | 'high';
  execute: (params: any, ctx?: ToolContext) => Promise<ToolResult>;
}

import type { ToolArtifact } from '../artifacts/types.js';
import type { ToolDescriptor } from '../tools/gateway.js';
export type { ToolArtifact } from '../artifacts/types.js';

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
  /**
   * `summary` 是 v0.7 新增的中期记忆：被滑窗挤出去的历史被压成一条摘要。
   * 它必须**落 session**（而不是只在内存里压）—— 否则 restore 出来的会话没有摘要，
   * 下一个请求会重新压一次：多花一次模型调用，且两次摘要可能不一致。
   */
  type: 'message' | 'tool_call' | 'tool_result' | 'metadata' | 'summary';
  data: Message | ToolCallEntry | ToolResultEntry | MetadataEntry | SummaryEntry;
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

export interface SummaryEntry {
  /** 摘要正文 */
  content: string;
  /** 被压缩掉的原始消息条数，用于审计「这条摘要顶替了多少内容」 */
  compactedCount: number;
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
  /** 定价是否精确命中窗口；非 exact 的记录在对账时应被筛出复核（v0.4） */
  pricingResolved: 'exact' | 'before-first' | 'after-last' | 'unknown-model';
}

// Agent config
export interface AgentConfig {
  model: string;
  apiKey?: string;
  maxTurns: number;
  maxTokensPerSession: number;
  systemPrompt: string;
  confirmHighRisk: boolean;
  /**
   * v0.10：流式脱敏的滞后窗口字符数。缺省 `DEFAULT_SAFETY_LAG`（40）。
   *
   * 设 0 关闭滞后 —— 换回 v0.4 的首字延迟，代价是**跨块的敏感串检测不到**。
   * 这个取舍要按场景定：面向消费者的客服流该开，内部工具链可以关。
   */
  safetyLag?: number;
}

// Agent events (流式事件)
export type AgentEvent =
  | { type: 'thinking'; content: string }
  /**
   * 模型输出的增量文本块（v0.4）。
   * 感知等待时间由**首字延迟**主导而非总时长，所以逐块吐出不是性能优化，是可用性问题。
   */
  | { type: 'delta'; text: string }
  | { type: 'tool_start'; toolName: string; input: Record<string, unknown> }
  | { type: 'tool_end'; toolName: string; result: ToolResult; durationMs: number }
  /**
   * 工具产出的结构化数据（v0.13）。单独一帧，便于客户端只订阅它做界面渲染，
   * 不必从 tool_end 里挑。
   */
  | { type: 'artifact'; toolName: string; artifact: ToolArtifact }
  /**
   * 工具调用**未进入执行**（v0.14）：工具不存在 / 参数不合法 / 高风险未通过确认。
   *
   * v0.14 之前这三种情况一个事件都不发 —— 模型收到一段文字，
   * 而 SSE 消费方与指标完全看不见。于是「工具调用总数」这个指标是**偏低**的，
   * 且偏低的正是最该被关注的那部分（被拦下的调用）。
   */
  | { type: 'tool_rejected'; toolName: string; reason: string }
  | { type: 'response'; content: string }
  /**
   * v1.2：错误事件带上**机器可读的分类**。
   *
   * 在此之前它只有一句中文。消费方要判断「该不该重试」只能做字符串匹配 ——
   * 而那句话是给人看的，随时会改。每个接入方各自发明一遍判断逻辑，
   * 且各不相同，这本身就是缺陷。
   */
  | { type: 'error'; error: string; code: TurnErrorCode; retryable: boolean }
  /** 被中间件拦截（注入检测 / 预算熔断 / 后续版本的合规与配额）；by 为中间件名 */
  | { type: 'blocked'; by: string; reason: string }
  /**
   * v1.0：本轮被取消（客户端断开）。
   * **刻意不是 error** —— 把用户主动关页面记成系统错误，会让错误率指标变成噪声。
   */
  | { type: 'cancelled'; reason: string }
  | { type: 'done'; totalTokens: TokenUsage; totalCost: number };

// ============ 轮次结果（v1.2）============

/**
 * 一轮对话的失败分类。
 *
 * `retryable` 由它决定，而不是由调用方猜：
 * 模型抖动值得重试，被安全规则拦下重试一万次也是同一个结果。
 */
export type TurnErrorCode =
  | 'model_error'
  | 'blocked'
  | 'max_turns'
  | 'internal_error';

export type TurnOutcome = 'ok' | 'blocked' | 'cancelled' | 'error' | 'max_turns';

/**
 * `AgentLoop.run()` 的返回值（v1.2）。
 *
 * v0.1~v1.1 期间它是一个字符串 —— 成功时是回复，失败时是
 * `LLM调用失败: xxx` 这样一句**冒充回复的错误正文**。CLI 会把它当客服的回答
 * 打给用户；HTTP 层要判断成败只能靠订阅事件旁路拼凑。
 *
 * **`reply` 与 `outcome` 分开**是这个类型存在的全部意义：
 * 状态用来判断，正文用来展示，两者揉在一个字符串里就只能靠字符串匹配。
 */
export interface TurnResult {
  /** `outcome !== 'ok'` 时是空串 —— 失败不该看起来像成功 */
  reply: string;
  outcome: TurnOutcome;
  error?: {
    code: TurnErrorCode;
    message: string;
    retryable: boolean;
  };
}

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
export interface ChatOptions {
  /**
   * v1.0：取消信号。客户端断开后模型调用要能被打断 ——
   * 一个没人看的回答，继续生成就是在付钱买垃圾。
   */
  signal?: AbortSignal;
  /**
   * 给了就逐块回调模型输出的文本增量，不给就只等最终结果。
   * 调用方不必关心流式细节 —— `chat()` 的返回值始终是完整的 ChatResponse。
   */
  onDelta?(text: string): void;
}

export interface ChatProvider {
  chat(
    systemPrompt: string,
    messages: Message[],
    /**
     * v0.15：从 `AgentTool[]` 换成 `ToolDescriptor[]` —— 模型只需要
     * 名称/描述/schema，不需要（也不该拿到）可执行的函数对象。
     * `AgentTool` 结构上兼容 `ToolDescriptor`，既有调用方不受影响。
     */
    tools: ToolDescriptor[],
    opts?: ChatOptions
  ): Promise<ChatResponse>;
  getModel(): string;
}
