import { requestFingerprint } from '../auth/api-key.js';
import type { IdempotencyStore, Principal } from '../auth/types.js';

export interface IdempotentOutcome {
  status: number;
  body: unknown;
  /** 本次是重放已有结果，而不是真的执行了一次 */
  replayed?: boolean;
}

/** 默认 24 小时。够长到覆盖人工重试，短到不会让库无限膨胀 */
export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 幂等键包装。
 *
 * 前面三个版本都在防重复执行（v0.3 退款库级幂等、v0.12 确认单一次性消费、
 * v1.0 高风险工具不重试），但**入口层完全敞着** —— 调用方一次网络超时重发，
 * 那是一个全新的请求、全新的 tool_use_id、全新的确认单，三道防线一道都不生效。
 *
 * 四种情形：
 * ```
 * 未命中             → 占位 → 执行 → 回填响应
 * 命中 + 体相同 + 已完成 → 重放存下的响应
 * 命中 + 体相同 + 处理中 → 409（不是排队等待 —— 那会把连接挂死）
 * 命中 + 体不同         → 409（**不是返回旧响应**）
 * ```
 *
 * 最后一条最容易做错：同 key 不同体返回旧响应，调用方会以为自己的新请求生效了，
 * 而实际上什么都没发生。这类「看起来成功了但没有」正是这个项目一路在修的东西。
 */
export async function withIdempotency(
  store: IdempotencyStore,
  principal: Principal,
  key: string | undefined,
  endpoint: string,
  payload: unknown,
  fn: () => Promise<IdempotentOutcome>,
  opts: { ttlMs?: number; now?: () => number } = {}
): Promise<IdempotentOutcome> {
  // 不带幂等键就是普通请求。**不强制** —— 强制会让所有既有调用方一夜之间全挂，
  // 而幂等键的价值在于"想要的人能拿到保证"，不在于人人都必须用
  if (!key) return fn();

  const now = opts.now ?? Date.now;
  const requestHash = requestFingerprint(payload);

  const claim = await store.claim({
    key,
    keyId: principal.keyId,
    endpoint,
    requestHash,
    ttlMs: opts.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS,
    now: now(),
  });

  if (!claim.claimed) {
    const existing = claim.existing;

    if (existing.requestHash !== requestHash) {
      return {
        status: 409,
        body: {
          error: {
            code: 'idempotency_key_reused',
            message: `幂等键 ${key} 已用于另一个请求（${existing.endpoint}）。同一个键必须对应同一个请求体`,
          },
        },
      };
    }

    if (existing.status === 'in_progress') {
      return {
        status: 409,
        body: {
          error: {
            code: 'request_in_progress',
            message: `幂等键 ${key} 对应的请求正在处理中，请稍后用同一个键重试`,
          },
        },
      };
    }

    return {
      status: existing.responseStatus ?? 200,
      body: existing.responseBody,
      replayed: true,
    };
  }

  try {
    const outcome = await fn();

    // **只有成功的结果才值得重放**。把 5xx 存下来重放，等于让一次偶发故障
    // 在整个 TTL 内被永久固化 —— 调用方拿同一个键重试永远拿到那个错误
    if (outcome.status < 500) {
      await store.complete({
        key,
        keyId: principal.keyId,
        responseStatus: outcome.status,
        responseBody: outcome.body,
      });
    } else {
      await store.release(key, principal.keyId);
    }

    return outcome;
  } catch (err) {
    // 抛异常时释放占位：失败往往是瞬时的，该让调用方能真的重来一次
    await store.release(key, principal.keyId).catch(() => {});
    throw err;
  }
}

/** 从请求头取幂等键。大小写不敏感由 Fastify 保证（headers 已小写化） */
export function readIdempotencyKey(headers: Record<string, unknown>): string | undefined {
  const raw = headers['idempotency-key'];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
