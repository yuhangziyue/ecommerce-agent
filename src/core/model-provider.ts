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
 * 内部 Message[] → Anthropic MessageParam[]。
 *
 * 关键约束：`tool` 角色消息必须转成携带 `tool_result` 块的 **user** 消息，
 * 且缺少 `toolResult` 的 tool 消息会被丢弃 —— 发出没有配对的 tool_result 会被 API 拒绝。
 * 导出以便单测直接断言配对形态。
 */
export function messagesToAnthropicFormat(
  messages: Message[]
): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      if (msg.toolUse) {
        result.push({
          role: 'assistant',
          content: [
            ...(msg.content
              ? [{ type: 'text' as const, text: msg.content }]
              : []),
            {
              type: 'tool_use' as const,
              id: msg.toolUse.id,
              name: msg.toolUse.name,
              input: msg.toolUse.input,
            },
          ],
        });
      } else {
        result.push({ role: 'assistant', content: msg.content });
      }
    } else if (msg.role === 'tool' && msg.toolResult) {
      result.push({
        role: 'user',
        content: [
          {
            type: 'tool_result' as const,
            tool_use_id: msg.toolResult.toolUseId,
            content: msg.toolResult.result.content,
            is_error: msg.toolResult.result.isError,
          },
        ],
      });
    }
  }

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

    const usage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: (response.usage as any).cache_read_input_tokens,
      cacheWriteTokens: (response.usage as any).cache_creation_input_tokens,
    };

    let textContent = '';
    let toolUse: ToolUse | undefined;

    for (const block of response.content) {
      if (block.type === 'text') {
        textContent += block.text;
      } else if (block.type === 'tool_use') {
        toolUse = {
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        };
      }
    }

    return {
      content: textContent,
      toolUse,
      usage,
      stopReason: response.stop_reason || 'end_turn',
    };
  }

  getModel(): string {
    return this.model;
  }

  setModel(model: string): void {
    this.model = model;
  }
}
