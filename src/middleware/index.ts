import { Pipeline, type AgentMiddleware } from '../core/pipeline.js';
import { BudgetGuard } from '../guardrails/budget-guard.js';
import { ContextManager } from '../memory/context-manager.js';
import type { TokenTracker } from '../core/token-tracker.js';
import { createInputFilterMiddleware } from './input-filter.mw.js';
import { createContextTrimMiddleware } from './context-trim.mw.js';
import { createBudgetGuardMiddleware } from './budget-guard.mw.js';
import { createOutputFilterMiddleware } from './output-filter.mw.js';

export { createInputFilterMiddleware } from './input-filter.mw.js';
export { createOutputFilterMiddleware } from './output-filter.mw.js';
export { createBudgetGuardMiddleware } from './budget-guard.mw.js';
export { createContextTrimMiddleware } from './context-trim.mw.js';
export { createCompactionMiddleware } from './compaction.mw.js';
export { createProfileMiddleware } from './profile.mw.js';

export interface DefaultPipelineOptions {
  /** 与 AgentLoop 共享同一个实例，否则预算检查看到的是另一份账 */
  tracker: TokenTracker;
  maxTokens: number;
  /** 上下文保留的最大消息数，默认 20 */
  maxMessages?: number;
  /** 预算达到预警线时的回调（CLI 打印 / 服务端埋点） */
  onWarn?: (warning: string) => void;
  /** 预算预警比例，默认 0.8 */
  warningThreshold?: number;
  /**
   * 上下文增强中间件（画像注入、意图识别）。
   *
   * 位置在 `input-filter` **之后** —— 这是硬约束：
   * 恶意输入必须先被拦住，一次模型调用都不该发生。v0.8 的意图识别是真实的
   * 模型调用，放在过滤之前等于给攻击者免费烧钱。
   */
  enrich?: AgentMiddleware[];
  /**
   * 插在 `context-trim` **之前**的中间件（v0.7 的摘要压缩走这里）。
   *
   * 顺序是硬约束不是偏好：滑窗一旦先跑，老消息已经被丢掉，
   * 压缩拿不到要压的内容，中期记忆等于不存在。
   * 把这个约束留在本模块里，调用方不需要知道管道的内部顺序。
   */
  beforeTrim?: AgentMiddleware[];
}

/**
 * 装配默认管道。
 *
 * 顺序是刻意的：
 * 1. `input-filter`  最先 —— 恶意输入不该走到后面任何一步，更不该消耗 token
 * 2. `context-trim`  在预算检查前 —— 先把该丢的历史丢掉，再判断预算，否则可能误熔断
 * 3. `budget-guard`  裁剪之后 —— 判断的是真实将要发出的规模
 * 4. `output-filter` 最后 —— 对最终文本做脱敏，前面任何改写都已定稿
 */
export function buildDefaultPipeline(opts: DefaultPipelineOptions): Pipeline {
  const {
    tracker,
    maxTokens,
    maxMessages = 20,
    onWarn,
    warningThreshold = 0.8,
  } = opts;

  return new Pipeline([
    createInputFilterMiddleware(),
    ...(opts.enrich ?? []),
    ...(opts.beforeTrim ?? []),
    createContextTrimMiddleware(new ContextManager(maxMessages)),
    createBudgetGuardMiddleware(
      new BudgetGuard(tracker, maxTokens, warningThreshold),
      onWarn
    ),
    createOutputFilterMiddleware(),
  ]);
}
