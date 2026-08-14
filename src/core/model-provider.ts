import Anthropic from '@anthropic-ai/sdk';
import type {
  AgentTool,
  ChatProvider,
  ChatResponse,
  Message,
  TokenUsage,
  ToolUse,
} from './types.js';
import type { TSchema } from '@sinclair/typebox';

/**
 * 工具定义 → Anthropic tool schema。
 * 导出以便单测直接断言转换结果，不必发真实请求。
 */
export function toolToAnthropicSchema(tool: AgentTool<TSchema>): Anthropic.Tool {
  const { type: _type, ...properties } = tool.parameters as any;
  return {
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object' as const,
      ...properties,
    },
  };
}

/**
 * Anthropic 响应 → 内部归一化的 ChatResponse。
 *
 * v0.3 从 `chat()` 里抽出来单独导出，两个目的：
 * 1. 可以直接单测「多个 tool_use 块是否被全部收集」，不必发真实请求
 * 2. 收集逻辑从 `let toolUse` 改为 `toolUses.push(...)` —— 原实现后者覆盖前者，
 *    Claude 默认开启 parallel tool use，一次响应可含多块，只留最后一个会让
 *    下一轮请求因缺少配对的 tool_result 被拒（400），表现为对话突然中断
 */
export function parseAnthropicResponse(
  response: Anthropic.Message
): ChatResponse {
  const usage: TokenUsage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheReadTokens: (response.usage as any).cache_read_input_tokens,
    cacheWriteTokens: (response.usage as any).cache_creation_input_tokens,
  };

  let textContent = '';
  const toolUses: ToolUse[] = [];

  for (const block of response.content) {
    if (block.type === 'text') {
      textContent += block.text;
    } else if (block.type === 'tool_use') {
      toolUses.push({
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      });
    }
  }

  return {
    content: textContent,
    toolUses,
    usage,
    stopReason: response.stop_reason || 'end_turn',
  };
}

/**
 * 内部 Message[] → Anthropic MessageParam[]。
 *
 * 两条关键约束：
 *
 * 1. `tool` 角色消息必须转成携带 `tool_result` 块的 **user** 消息；缺少 `toolResult`
 *    的 tool 消息会被丢弃 —— 发出没有配对的 tool_result 会被 API 拒绝。
 *
 * 2. **连续的** tool 消息必须合并进**同一条** user 消息。把多个 tool_result 拆到多条
 *    user 消息里发出，会训练模型停止做并行工具调用（Anthropic 文档明确指出），
 *    并行带来的延迟收益会被自己作废。
 *
 * 内部表示保持简单（工具结果仍是 N 条独立消息，便于逐条落盘/计时/审计），
 * 合并只发生在这一层。
 */
export function messagesToAnthropicFormat(
  messages: Message[]
): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];
  let pendingToolResults: Anthropic.ToolResultBlockParam[] = [];

  const flushToolResults = (): void => {
    if (pendingToolResults.length > 0) {
      result.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const msg of messages) {
    if (msg.role === 'tool') {
      if (msg.toolResult) {
        pendingToolResults.push({
          type: 'tool_result',
          tool_use_id: msg.toolResult.toolUseId,
          content: msg.toolResult.result.content,
          is_error: msg.toolResult.result.isError,
        });
      }
      continue;
    }

    // 遇到非 tool 消息，先把攒着的一组结果作为一条 user 消息发出
    flushToolResults();

    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      if (msg.toolUses && msg.toolUses.length > 0) {
        result.push({
          role: 'assistant',
          content: [
            ...(msg.content ? [{ type: 'text' as const, text: msg.content }] : []),
            ...msg.toolUses.map((tu) => ({
              type: 'tool_use' as const,
              id: tu.id,
              name: tu.name,
              input: tu.input,
            })),
          ],
        });
      } else {
        result.push({ role: 'assistant', content: msg.content });
      }
    }
    // system 角色不进 messages —— 走顶层 system 参数
  }

  flushToolResults();
  return result;
}

export class ModelProvider implements ChatProvider {
  private client: Anthropic;
  private model: string;

  constructor(model: string, apiKey?: string) {
    this.model = model;
    this.client = new Anthropic({
      apiKey: apiKey || process.env.ANTHROPIC_API_KEY,
    });
  }

  async chat(
    systemPrompt: string,
    messages: Message[],
    tools: AgentTool<TSchema>[]
  ): Promise<ChatResponse> {
    const anthropicMessages = messagesToAnthropicFormat(messages);
    const anthropicTools = tools.map(toolToAnthropicSchema);

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: anthropicMessages,
      ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
    });

    return parseAnthropicResponse(response);
  }

  getModel(): string {
    return this.model;
  }

  setModel(model: string): void {
    this.model = model;
  }
}
