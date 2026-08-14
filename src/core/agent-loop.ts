import Ajv from 'ajv';
import type { TSchema } from '@sinclair/typebox';
import { ModelProvider } from './model-provider.js';
import { TokenTracker } from './token-tracker.js';
import { Session } from './session.js';
import type {
  AgentConfig,
  AgentEvent,
  AgentTool,
  Message,
  ToolResult,
} from './types.js';

const ajv = new Ajv({ allErrors: true });

export type EventHandler = (event: AgentEvent) => void;
export type ConfirmHandler = (
  toolName: string,
  input: Record<string, unknown>
) => Promise<boolean>;

export class AgentLoop {
  private provider: ModelProvider;
  private tools: Map<string, AgentTool<TSchema>> = new Map();
  private tracker: TokenTracker;
  private session: Session;
  private config: AgentConfig;
  private onEvent: EventHandler;
  private onConfirm: ConfirmHandler;
  private conversationMessages: Message[] = [];

  constructor(
    config: AgentConfig,
    tools: AgentTool<TSchema>[],
    session: Session,
    onEvent: EventHandler,
    onConfirm: ConfirmHandler
  ) {
    this.config = config;
    this.provider = new ModelProvider(config.model, config.apiKey);
    this.tracker = new TokenTracker();
    this.session = session;
    this.onEvent = onEvent;
    this.onConfirm = onConfirm;

    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }

    // 恢复已有session中的消息
    const existingMessages = session.getMessages();
    if (existingMessages.length > 0) {
      this.conversationMessages = existingMessages;
    }
  }

  async run(userInput: string): Promise<string> {
    // 添加用户消息
    const userMessage: Message = {
      role: 'user',
      content: userInput,
      timestamp: Date.now(),
    };
    this.conversationMessages.push(userMessage);
    this.session.appendMessage(userMessage);

    let turns = 0;
    const toolArray = Array.from(this.tools.values());

    while (turns < this.config.maxTurns) {
      turns++;

      // 检查token预算
      if (this.tracker.isOverBudget(this.config.maxTokensPerSession)) {
        const errorMsg = '已超出本次会话的token预算限制，请开启新会话。';
        this.onEvent({ type: 'error', error: errorMsg });
        return errorMsg;
      }

      // 调用LLM
      let response;
      try {
        response = await this.provider.chat(
          this.config.systemPrompt,
          this.conversationMessages,
          toolArray
        );
      } catch (err: any) {
        const errorMsg = `LLM调用失败: ${err.message}`;
        this.onEvent({ type: 'error', error: errorMsg });
        return errorMsg;
      }

      // 记录token消耗
      this.tracker.add(response.usage, this.config.model);

      // 如果有文本回复（可能伴随tool_use）
      if (response.content && !response.toolUse) {
        // 最终文本回复，无工具调用
        const assistantMessage: Message = {
          role: 'assistant',
          content: response.content,
          timestamp: Date.now(),
        };
        this.conversationMessages.push(assistantMessage);
        this.session.appendMessage(assistantMessage);

        this.onEvent({ type: 'response', content: response.content });
        this.emitDone();
        return response.content;
      }

      if (response.toolUse) {
        const toolUse = response.toolUse;
        const tool = this.tools.get(toolUse.name);

        // 记录assistant带tool_use的消息
        const assistantMessage: Message = {
          role: 'assistant',
          content: response.content || '',
          toolUse,
          timestamp: Date.now(),
        };
        this.conversationMessages.push(assistantMessage);
        this.session.appendMessage(assistantMessage);

        if (response.content) {
          this.onEvent({ type: 'thinking', content: response.content });
        }

        if (!tool) {
          // 工具不存在
          const errorResult: ToolResult = {
            content: `工具 "${toolUse.name}" 不存在。可用工具: ${Array.from(this.tools.keys()).join(', ')}`,
            isError: true,
          };
          const toolResultMessage: Message = {
            role: 'tool',
            content: errorResult.content,
            toolResult: { toolUseId: toolUse.id, result: errorResult },
            timestamp: Date.now(),
          };
          this.conversationMessages.push(toolResultMessage);
          this.session.appendToolResult({
            toolUseId: toolUse.id,
            result: errorResult,
            durationMs: 0,
          });
          continue;
        }

        // 参数校验
        const validate = ajv.compile(tool.parameters as any);
        if (!validate(toolUse.input)) {
          const errorResult: ToolResult = {
            content: `参数校验失败: ${ajv.errorsText(validate.errors)}`,
            isError: true,
          };
          const toolResultMessage: Message = {
            role: 'tool',
            content: errorResult.content,
            toolResult: { toolUseId: toolUse.id, result: errorResult },
            timestamp: Date.now(),
          };
          this.conversationMessages.push(toolResultMessage);
          this.session.appendToolResult({
            toolUseId: toolUse.id,
            result: errorResult,
            durationMs: 0,
          });
          continue;
        }

        // 高风险工具确认
        if (tool.riskLevel === 'high' && this.config.confirmHighRisk) {
          const confirmed = await this.onConfirm(toolUse.name, toolUse.input);
          if (!confirmed) {
            const cancelResult: ToolResult = {
              content: '用户取消了该操作。',
              isError: false,
            };
            const toolResultMessage: Message = {
              role: 'tool',
              content: cancelResult.content,
              toolResult: { toolUseId: toolUse.id, result: cancelResult },
              timestamp: Date.now(),
            };
            this.conversationMessages.push(toolResultMessage);
            this.session.appendToolResult({
              toolUseId: toolUse.id,
              result: cancelResult,
              durationMs: 0,
            });
            continue;
          }
        }

        // 执行工具
        this.onEvent({ type: 'tool_start', toolName: toolUse.name, input: toolUse.input });
        this.session.appendToolCall({
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          input: toolUse.input,
        });

        const startTime = Date.now();
        let result: ToolResult;
        try {
          result = await tool.execute(toolUse.input);
        } catch (err: any) {
          result = {
            content: `工具执行出错: ${err.message}`,
            isError: true,
          };
        }
        const durationMs = Date.now() - startTime;

        this.onEvent({ type: 'tool_end', toolName: toolUse.name, result, durationMs });
        this.session.appendToolResult({
          toolUseId: toolUse.id,
          result,
          durationMs,
        });

        // 把工具结果作为tool角色消息喂回
        const toolResultMessage: Message = {
          role: 'tool',
          content: result.content,
          toolResult: { toolUseId: toolUse.id, result },
          timestamp: Date.now(),
        };
        this.conversationMessages.push(toolResultMessage);

        // 继续循环让模型处理工具结果
        continue;
      }

      // 没有content也没有toolUse（不太可能，兜底）
      const fallback = '抱歉，我暂时无法处理您的请求，请稍后再试。';
      this.onEvent({ type: 'response', content: fallback });
      this.emitDone();
      return fallback;
    }

    // 超过maxTurns
    const maxTurnMsg = `已达到最大交互轮次(${this.config.maxTurns})，请简化您的问题或开启新会话。`;
    this.onEvent({ type: 'error', error: maxTurnMsg });
    this.emitDone();
    return maxTurnMsg;
  }

  private emitDone(): void {
    this.onEvent({
      type: 'done',
      totalTokens: this.tracker.getUsage(),
      totalCost: this.tracker.getTotalCost(),
    });
  }

  getTracker(): TokenTracker {
    return this.tracker;
  }

  getSession(): Session {
    return this.session;
  }
}
