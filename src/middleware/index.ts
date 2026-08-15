import { Pipeline, type AgentMiddleware } from '../core/pipeline.js';
import { BudgetGuard } from '../guardrails/budget-guard.js';
import { ContextManager } from '../memory/context-manager.js';
import type { TokenTracker } from '../core/token-tracker.js';
import { createContextTrimMiddleware } from './context-trim.mw.js';
import { createBudgetGuardMiddleware } from './budget-guard.mw.js';
import { createSafetyMiddleware, type SafetyAuditEntry } from './safety.mw.js';
import { createQuotaMiddleware } from './quota.mw.js';
import type { Session } from '../core/session.js';
import type { QuotaService } from '../billing/quota.js';

export { createInputFilterMiddleware } from './input-filter.mw.js';
export { createOutputFilterMiddleware } from './output-filter.mw.js';
export { createBudgetGuardMiddleware } from './budget-guard.mw.js';
export { createContextTrimMiddleware } from './context-trim.mw.js';
export { createCompactionMiddleware } from './compaction.mw.js';
export { createProfileMiddleware } from './profile.mw.js';
export { createQuotaMiddleware, QUOTA_SCOPE_KEY } from './quota.mw.js';
export {
  createSafetyMiddleware,
  readSafetyAudit,
  SAFETY_AUDIT_KEY,
  type SafetyAuditEntry,
} from './safety.mw.js';

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
  /**
   * v0.10 安全中间件的接线（取代 v0.2 的 input-filter / output-filter）。
   *
   * `session` 用于把每次非 allow 的裁决写成审计条目 —— 不传就只有内存回调，
   * 排障时查不到「上周三那次拦截是哪条规则命中的」。
   */
  safety?: {
    session?: Session;
    onVerdict?: (entry: SafetyAuditEntry) => void;
  };
  /**
   * v0.11 配额服务。**传了就取代 `budget-guard`** ——
   * 后者读的是进程内计数器，活不过一个 HTTP 请求（见 quota.mw.ts 的说明）。
   *
   * 不传则保留 `budget-guard`：单进程 CLI / 纯内存测试仍然可用，
   * 只是它限的是「单次 run 内」的用量，名副其实而已。
   */
  quota?: {
    service: QuotaService;
    tenantId?: string | null;
    onExceeded?: (scope: 'tenant' | 'session', reason: string) => void;
  };
}

/**
 * 装配默认管道。
 *
 * 顺序是刻意的：
 * 1. `safety`       最先 —— 恶意输入不该走到后面任何一步，更不该消耗 token；
 *                   同一实例的 `afterTurn` 兼管输出脱敏（v0.10 合并了原来的两个过滤器）
 * 2. `context-trim` 在配额检查前 —— 先把该丢的历史丢掉，再判断用量，否则可能误熔断
 * 3. `quota`（或退化的 `budget-guard`）裁剪之后 —— 判断的是真实将要发出的规模
 */
export function buildDefaultPipeline(opts: DefaultPipelineOptions): Pipeline {
  const {
    tracker,
    maxTokens,
    maxMessages = 20,
    onWarn,
    warningThreshold = 0.8,
  } = opts;

  // 安全中间件一个实例挂两头：beforeTurn 判入参、afterTurn 脱敏出参。
  // 拆成两个实例会让审计回调各记一份，统计口径对不上。
  const safety = createSafetyMiddleware(opts.safety ?? {});

  return new Pipeline([
    safety,
    ...(opts.enrich ?? []),
    ...(opts.beforeTrim ?? []),
    createContextTrimMiddleware(new ContextManager(maxMessages)),
    opts.quota
      ? createQuotaMiddleware({
          quota: opts.quota.service,
          tenantId: opts.quota.tenantId,
          onExceeded: opts.quota.onExceeded,
          onWarn,
        })
      : createBudgetGuardMiddleware(
          new BudgetGuard(tracker, maxTokens, warningThreshold),
          onWarn
        ),
  ]);
}
