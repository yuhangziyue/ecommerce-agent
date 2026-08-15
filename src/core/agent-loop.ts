import { ModelProvider } from './model-provider.js';
import { TokenTracker } from './token-tracker.js';
import { Session } from './session.js';
import { Pipeline, type TurnContext } from './pipeline.js';
import { EventBus } from './event-bus.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { ResponseScorer } from '../evaluation/response-scorer.js';
import type { TrajectoryLogger } from '../evaluation/trajectory-logger.js';
import type { StreamingRedactor } from '../safety/streaming-redactor.js';
import type {
  AgentConfig,
  AgentEvent,
  AgentTool,
  ChatProvider,
  Message,
  ToolResult,
  ToolUse,
} from './types.js';

/**
 * 单个工具调用的执行计划。
 * 先把「查找 + 校验 + 确认」全部算完再执行，是为了让高风险确认能串行、其余能并发。
 */
interface ToolPlan {
  toolUse: ToolUse;
  tool?: AgentTool;
  /** 非空表示这个调用不进入执行阶段（工具不存在 / 参数不合法 / 用户拒绝） */
  error?: ToolResult;
  durationMs?: number;
}

export type EventHandler = (event: AgentEvent) => void;
export type ConfirmHandler = (
  toolName: string,
  input: Record<string, unknown>
) => Promise<boolean>;

/**
 * AgentLoop 的依赖。
 *
 * v0.2 从位置参数改为对象注入 —— 原因不是风格偏好：原先 `new ModelProvider()` 写在
 * 构造函数里，测试无法替换，导致循环编排/预算熔断/确认拒绝/工具报错这些路径不可测。
 */
export interface AgentLoopDeps {
  config: AgentConfig;
  registry: ToolRegistry;
  session: Session;
  /** 缺省时按 config 构造真实 ModelProvider；测试注入脚本化假实现 */
  provider?: ChatProvider;
  /** 缺省表示不挂任何横切能力（裸奔模式，仅用于测试与最小化排障） */
  pipeline?: Pipeline;
  /** 与 pipeline 里的 BudgetGuard 共享同一实例，否则两边各记一份账 */
  tracker?: TokenTracker;
  onEvent?: EventHandler;
  /** 直接注入总线（v0.6 SSE 适配器用）；缺省时内部新建 */
  bus?: EventBus;
  onConfirm?: ConfirmHandler;
  scorer?: ResponseScorer;
  trajectory?: TrajectoryLogger;
  /**
   * v0.10：流式脱敏器工厂。**每次模型调用新建一个** —— 脱敏器持有缓冲区状态，
   * 跨调用复用会把上一次的尾巴混进这一次。缺省表示 delta 直放（v0.4 行为）。
   */
  redactor?: () => StreamingRedactor;
}

export class AgentLoop {
  private readonly provider: ChatProvider;
  private readonly registry: ToolRegistry;
  private readonly tracker: TokenTracker;
  private readonly session: Session;
  private readonly config: AgentConfig;
  private readonly pipeline: Pipeline;
  private readonly bus: EventBus;
  private readonly onConfirm: ConfirmHandler;
  private readonly scorer?: ResponseScorer;
  private readonly redactorFactory?: () => StreamingRedactor;
  private conversationMessages: Message[] = [];

  constructor(deps: AgentLoopDeps) {
    this.config = deps.config;
    this.registry = deps.registry;
    this.session = deps.session;
    this.provider =
      deps.provider ?? new ModelProvider(deps.config.model, deps.config.apiKey);
    this.tracker = deps.tracker ?? new TokenTracker();
    this.pipeline = deps.pipeline ?? new Pipeline([]);
    this.onConfirm = deps.onConfirm ?? (async () => true);
    this.scorer = deps.scorer;
    this.redactorFactory = deps.redactor;

    // v0.4：事件分发收敛到总线。`onEvent` 与 `trajectory` 从「Loop 的两套并行机制」
    // 降级为两个普通订阅者 —— 调用方签名不变，但 v0.6 的 SSE 写出器可以直接
    // getEventBus().subscribe(...) 挂上来，不需要再改 Loop。
    this.bus = deps.bus ?? new EventBus();
    if (deps.onEvent) this.bus.subscribe(deps.onEvent);
    if (deps.trajectory) {
      const trajectory = deps.trajectory;
      this.bus.subscribe((event) => trajectory.log(event));
    }

    // 恢复已有 session 中的消息
    const existingMessages = deps.session.getMessages();
    if (existingMessages.length > 0) {
      this.conversationMessages = existingMessages;
    }
  }

  async run(userInput: string): Promise<string> {
    const ctx: TurnContext = {
      sessionId: this.session.getId(),
      userInput,
      messages: this.conversationMessages,
      systemAppends: [],
      metadata: {},
    };

    // ── 钩子 1：beforeTurn —— 恶意输入在这里被拦住，不消耗任何 token ──
    const pre = await this.pipeline.runBeforeTurn(ctx);
    if (pre.blocked) {
      return this.blockTurn(pre.blocked.by, pre.blocked.reason);
    }

    // 用改写后的输入（若有中间件改写过）
    const userMessage: Message = {
      role: 'user',
      content: ctx.userInput,
      timestamp: Date.now(),
    };
    this.conversationMessages.push(userMessage);
    await this.session.appendMessage(userMessage);

    const toolsUsed: string[] = [];
    let turns = 0;

    while (turns < this.config.maxTurns) {
      turns++;

      // ── 钩子 2：beforeModel —— 上下文裁剪与预算/配额熔断 ──
      ctx.messages = this.conversationMessages;
      const mid = await this.pipeline.runBeforeModel(ctx);
      if (mid.blocked) {
        return this.blockTurn(mid.blocked.by, mid.blocked.reason);
      }
      // 裁剪结果就是本次真实发出的消息集
      this.conversationMessages = ctx.messages;

      let response;
      // v0.10：每次模型调用一个独立脱敏器。滞后窗口压住的尾巴必须在本次调用
      // 结束时放出 —— 无论成功还是抛错，否则用户会看到被截断的半句话。
      const redactor = this.redactorFactory?.();
      const flushRedactor = (): void => {
        if (!redactor) return;
        const rest = redactor.flush();
        if (rest) this.emit({ type: 'delta', text: rest });
      };
      try {
        // 中间件本轮追加的 system 上下文（画像/意图/路由说明）拼在基础提示词之后
        const systemPrompt =
          ctx.systemAppends.length > 0
            ? `${this.config.systemPrompt}\n\n${ctx.systemAppends.join('\n\n')}`
            : this.config.systemPrompt;

        // 按本轮路由结果收窄工具面。注册表本身不变 —— 过滤只影响这一轮
        // 发给模型的列表，不影响工具能否被执行（见 TurnContext.allowedTools）
        const visibleTools = ctx.allowedTools
          ? this.registry.getAll().filter((t) => ctx.allowedTools!.includes(t.name))
          : this.registry.getAll();

        response = await this.provider.chat(
          systemPrompt,
          this.conversationMessages,
          visibleTools,
          {
            onDelta: (text) => {
              if (!redactor) {
                this.emit({ type: 'delta', text });
                return;
              }
              // 只放出「已确认不会与后续内容拼成敏感串」的部分，可能是空串
              const safe = redactor.feed(text);
              if (safe) this.emit({ type: 'delta', text: safe });
            },
          }
        );
        flushRedactor();
      } catch (err: any) {
        flushRedactor();
        const errorMsg = `LLM调用失败: ${err.message}`;
        this.emit({ type: 'error', error: errorMsg });
        this.emitDone();
        return errorMsg;
      }

      this.tracker.add(response.usage, this.config.model);

      // ── 情况 A：纯文本回复，本轮收口 ──
      if (response.content && response.toolUses.length === 0) {
        return await this.finishTurn(ctx, response.content, toolsUsed);
      }

      // ── 情况 B：工具调用（可能是多个，Claude 默认开启 parallel tool use）──
      if (response.toolUses.length > 0) {
        const assistantMessage: Message = {
          role: 'assistant',
          content: response.content || '',
          toolUses: response.toolUses,
          timestamp: Date.now(),
        };
        this.conversationMessages.push(assistantMessage);
        await this.session.appendMessage(assistantMessage);

        if (response.content) {
          this.emit({ type: 'thinking', content: response.content });
        }

        await this.executeToolUses(response.toolUses, toolsUsed);
        continue;
      }

      // ── 情况 C：既无文本也无工具调用（兜底）──
      return await this.finishTurn(
        ctx,
        '抱歉，我暂时无法处理您的请求，请稍后再试。',
        toolsUsed
      );
    }

    const maxTurnMsg = `已达到最大交互轮次(${this.config.maxTurns})，请简化您的问题或开启新会话。`;
    this.emit({ type: 'error', error: maxTurnMsg });
    this.emitDone();
    return maxTurnMsg;
  }

  /**
   * 执行一次响应里的全部工具调用，四个阶段：
   *
   * 1. **全量规划**（查找 + 参数校验）—— 不合法的调用不进入执行阶段
   * 2. **串行确认**高风险工具 —— 同时弹三个确认框，用户不知道自己在批准什么
   * 3. **并发执行**其余工具 —— 三个互不依赖的查询工具串行是三倍延迟
   * 4. **按原序回喂**结果 —— 顺序错乱会让模型把结果配错工具
   *
   * 不变量：**每个 tool_use 必须产生恰好一条 tool 结果消息**（包括失败与被拒的），
   * 否则下一轮请求会因缺少配对被 API 拒绝。
   */
  private async executeToolUses(
    toolUses: ToolUse[],
    toolsUsed: string[]
  ): Promise<void> {
    // 阶段 1：全量规划
    const plans: ToolPlan[] = toolUses.map((toolUse) => {
      const tool = this.registry.get(toolUse.name);
      if (!tool) {
        return {
          toolUse,
          error: {
            content:
              `工具 "${toolUse.name}" 不存在。可用工具: ` +
              this.registry
                .getAll()
                .map((t) => t.name)
                .join(', '),
            isError: true,
          },
        };
      }

      const validation = this.registry.validate(toolUse.name, toolUse.input);
      if (!validation.ok) {
        return {
          toolUse,
          error: {
            content: `参数校验失败: ${validation.error}`,
            isError: true,
          },
        };
      }

      return { toolUse, tool };
    });

    // 阶段 2：高风险串行确认
    for (const plan of plans) {
      if (plan.error || !plan.tool) continue;
      if (plan.tool.riskLevel === 'high' && this.config.confirmHighRisk) {
        const confirmed = await this.onConfirm(plan.toolUse.name, plan.toolUse.input);
        if (!confirmed) {
          plan.error = { content: '用户取消了该操作。', isError: false };
        }
      }
    }

    // 阶段 3：并发执行（Promise.all 按输入顺序返回，天然保序）
    const results = await Promise.all(
      plans.map(async (plan): Promise<ToolResult> => {
        if (plan.error) return plan.error;

        const tool = plan.tool!;
        this.emit({
          type: 'tool_start',
          toolName: plan.toolUse.name,
          input: plan.toolUse.input,
        });
        await this.session.appendToolCall({
          toolUseId: plan.toolUse.id,
          toolName: plan.toolUse.name,
          input: plan.toolUse.input,
        });

        const startTime = Date.now();
        let result: ToolResult;
        try {
          result = await tool.execute(plan.toolUse.input);
        } catch (err: any) {
          result = { content: `工具执行出错: ${err.message}`, isError: true };
        }
        plan.durationMs = Date.now() - startTime;

        this.emit({
          type: 'tool_end',
          toolName: plan.toolUse.name,
          result,
          durationMs: plan.durationMs,
        });
        return result;
      })
    );

    // 阶段 4：按原序回喂（串行 await —— 落库顺序必须与 tool_use 顺序一致）
    for (const [i, plan] of plans.entries()) {
      if (!plan.error) toolsUsed.push(plan.toolUse.name);
      await this.pushToolResult(plan.toolUse.id, results[i], plan.durationMs ?? 0);
    }
  }

  /**
   * 收口一轮：跑 afterTurn 钩子（脱敏/合规改写）→ 落盘 → 打分 → emit。
   * 落盘的是**改写后**的文本，会话历史里不留原始 PII。
   */
  private async finishTurn(
    ctx: TurnContext,
    rawReply: string,
    toolsUsed: string[]
  ): Promise<string> {
    const post = await this.pipeline.runAfterTurn(ctx, rawReply);
    if (post.blocked) {
      return this.blockTurn(post.blocked.by, post.blocked.reason);
    }
    const reply = post.text;

    const assistantMessage: Message = {
      role: 'assistant',
      content: reply,
      timestamp: Date.now(),
    };
    this.conversationMessages.push(assistantMessage);
    await this.session.appendMessage(assistantMessage);

    if (this.scorer) {
      const score = this.scorer.score(ctx.userInput, reply, toolsUsed);
      await this.session.appendMetadata('score', score);
    }
    if (post.rewrittenBy.length > 0) {
      await this.session.appendMetadata('rewrittenBy', post.rewrittenBy);
    }

    this.emit({ type: 'response', content: reply });
    this.emitDone();
    return reply;
  }

  /** 被中间件拦截：emit blocked + done（终端事件必须成对，v0.6 SSE 依赖这个保证） */
  private async blockTurn(by: string, reason: string): Promise<string> {
    this.emit({ type: 'blocked', by, reason });
    await this.session.appendMetadata('blocked', { by, reason });
    this.emitDone();
    return reason;
  }

  private async pushToolResult(
    toolUseId: string,
    result: ToolResult,
    durationMs = 0
  ): Promise<void> {
    const message: Message = {
      role: 'tool',
      content: result.content,
      toolResult: { toolUseId, result },
      timestamp: Date.now(),
    };
    this.conversationMessages.push(message);
    await this.session.appendToolResult({ toolUseId, result, durationMs });
  }

  private emit(event: AgentEvent): void {
    this.bus.emit(event);
  }

  /** 供外部订阅事件流（v0.6 的 SSE 写出器、v0.14 的指标埋点） */
  getEventBus(): EventBus {
    return this.bus;
  }

  private emitDone(): void {
    this.emit({
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

  /** 已装载的中间件名，启动时打印便于确认「能力确实通电了」 */
  getPipelineNames(): string[] {
    return this.pipeline.names;
  }
}
