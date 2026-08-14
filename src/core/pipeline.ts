import type { Message } from './types.js';

/**
 * 一轮对话的可变上下文，在三个钩子点之间传递。
 *
 * 中间件可以就地修改 `userInput` / `messages` / `metadata`，
 * 但不该改 `sessionId` / `userId` —— 那是这一轮的身份，不是可协商的内容。
 */
export interface TurnContext {
  readonly sessionId: string;
  readonly userId?: string;
  userInput: string;
  messages: Message[];
  readonly metadata: Record<string, unknown>;
}

export type MiddlewareOutcome =
  /** 放行，交给下一个中间件 */
  | { action: 'continue' }
  /** 拦截本轮：立即短路，Loop 不再调用模型，把 reason 返回给调用方 */
  | { action: 'block'; reason: string }
  /** 改写文本后继续：beforeTurn/beforeModel 改写用户输入，afterTurn 改写回复 */
  | { action: 'rewrite'; text: string };

/**
 * 横切能力的挂载点。三个钩子都是可选的 —— 只实现关心的那个。
 *
 * - `beforeTurn`  用户输入进入 Loop 前，每轮一次。适合：注入检测、内容合规、会话鉴权
 * - `beforeModel` 每次调用模型前，一轮内可能多次。适合：预算熔断、上下文裁剪、配额检测
 * - `afterTurn`   最终回复返回前，每轮一次。适合：PII 脱敏、合规声明、回答打分
 */
export interface AgentMiddleware {
  readonly name: string;
  beforeTurn?(ctx: TurnContext): Promise<MiddlewareOutcome> | MiddlewareOutcome;
  beforeModel?(ctx: TurnContext): Promise<MiddlewareOutcome> | MiddlewareOutcome;
  afterTurn?(
    ctx: TurnContext,
    reply: string
  ): Promise<MiddlewareOutcome> | MiddlewareOutcome;
}

export interface HookResult {
  /** 有值表示本轮被拦截，`by` 是拦截它的中间件名 */
  blocked?: { by: string; reason: string };
  /** 经过所有 rewrite 之后的文本 */
  text: string;
  /** 依次改写过文本的中间件名，便于排障与审计 */
  rewrittenBy: string[];
}

type HookName = 'beforeTurn' | 'beforeModel' | 'afterTurn';

/**
 * 中间件管道执行器。
 *
 * 存在的理由：把 guardrail / 记忆 / 计费这类横切能力从 AgentLoop 里拿出来。
 * 否则每加一个能力就要改一次 Loop，v0.10 安全增强 + v0.11 计费检测会把 Loop 撑成泥球。
 */
export class Pipeline {
  private readonly middlewares: AgentMiddleware[];

  constructor(middlewares: AgentMiddleware[] = []) {
    this.middlewares = middlewares;
  }

  get names(): string[] {
    return this.middlewares.map((m) => m.name);
  }

  runBeforeTurn(ctx: TurnContext): Promise<HookResult> {
    return this.runHook('beforeTurn', ctx, ctx.userInput);
  }

  runBeforeModel(ctx: TurnContext): Promise<HookResult> {
    return this.runHook('beforeModel', ctx, ctx.userInput);
  }

  runAfterTurn(ctx: TurnContext, reply: string): Promise<HookResult> {
    return this.runHook('afterTurn', ctx, reply);
  }

  private async runHook(
    hook: HookName,
    ctx: TurnContext,
    initialText: string
  ): Promise<HookResult> {
    let text = initialText;
    const rewrittenBy: string[] = [];

    for (const mw of this.middlewares) {
      const fn = mw[hook];
      if (!fn) continue;

      const outcome =
        hook === 'afterTurn'
          ? await (fn as NonNullable<AgentMiddleware['afterTurn']>).call(
              mw,
              ctx,
              text
            )
          : await (fn as NonNullable<AgentMiddleware['beforeTurn']>).call(
              mw,
              ctx
            );

      if (outcome.action === 'block') {
        return { blocked: { by: mw.name, reason: outcome.reason }, text, rewrittenBy };
      }

      if (outcome.action === 'rewrite') {
        text = outcome.text;
        rewrittenBy.push(mw.name);
        // 输入侧的改写要写回上下文，后续中间件与模型调用都应看到改写后的输入
        if (hook !== 'afterTurn') {
          ctx.userInput = text;
        }
      }
    }

    return { text, rewrittenBy };
  }
}
