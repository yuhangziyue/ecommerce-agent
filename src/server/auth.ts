import type { FastifyReply, FastifyRequest } from 'fastify';
import { hashApiKey, parseBearer } from '../auth/api-key.js';
import type { ApiKeyStore, Principal, Scope } from '../auth/types.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * 本次请求的身份。**认证钩子跑过之后必然有值**（钩子要么注入要么已经 401），
     * 但类型上仍是可选 —— Fastify 的装饰器无法表达「某些路由之后一定有」。
     * 业务代码用 `principalOf(request)` 取，那里把这个断言收在一处。
     */
    principal?: Principal;
  }
}

/** 免认证路径：抓取端与 LB 探针没有凭证，也不返回任何租户数据 */
export const PUBLIC_PATHS = new Set(['/metrics', '/healthz']);

export const AUTH_DISABLED_WARNING =
  '[auth] ⚠️  AGENT_AUTH_DISABLED=1 —— 认证已关闭，任何人都可以调用本服务并指定任意租户。仅用于本地开发。';

/** 认证关闭时所有请求共用的身份。`anonymous` 让日志/指标能把这类请求分出来 */
export const DISABLED_PRINCIPAL: Principal = {
  keyId: 'key_auth_disabled',
  tenantId: 'anonymous',
  scopes: ['chat', 'read', 'write', 'admin'],
  anonymous: true,
};

export interface AuthOptions {
  keys: ApiKeyStore;
  /** 显式关闭认证。**默认 false** —— 默认值站在出错时损失最小的一侧 */
  disabled?: boolean;
  /** 注入便于测试；生产用 Date.now */
  now?: () => number;
}

function unauthorized(reply: FastifyReply) {
  // **所有认证失败返回同一个错误体**：没带、格式错、不存在、已吊销 ——
  // 区分开报只是在告诉攻击者他离对还差几步。
  // 401 必须带 WWW-Authenticate（RFC 7235），否则规范的 HTTP 客户端不知道该怎么补救
  return reply
    .status(401)
    .header('WWW-Authenticate', 'Bearer realm="ecommerce-agent"')
    .send({ error: { code: 'unauthorized', message: '凭证无效或缺失' } });
}

/**
 * 认证钩子。挂在 `onRequest` 上 —— 越早越好：
 * 未认证的请求不该走到请求体解析，更不该消耗任何下游资源。
 */
export function createAuthHook(opts: AuthOptions) {
  const now = opts.now ?? Date.now;

  return async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    if (PUBLIC_PATHS.has(request.routeOptions?.url ?? request.url)) return;

    if (opts.disabled) {
      request.principal = DISABLED_PRINCIPAL;
      return;
    }

    const plaintext = parseBearer(request.headers.authorization);
    if (!plaintext) return unauthorized(reply);

    const record = await opts.keys.findByHash(hashApiKey(plaintext));
    if (!record) return unauthorized(reply);
    // 已吊销与不存在返回**同样的错误体** —— 否则这就是一个
    // 「这把钥匙曾经存在过吗」的探测接口
    if (record.revokedAt !== null) return unauthorized(reply);

    request.principal = {
      keyId: record.keyId,
      tenantId: record.tenantId,
      scopes: record.scopes,
    };

    // 审计信息，失败不影响请求。刻意不 await —— 认证路径上每一毫秒都在所有请求上乘一遍
    void opts.keys.touch(record.keyId, now()).catch(() => {});
  };
}

/**
 * 取出身份。
 *
 * 钩子跑过之后必然有值；取不到说明有人把某个路由挂在了认证之外，
 * **那是配置事故，应当立刻炸掉而不是当成匿名放行**。
 */
export function principalOf(request: FastifyRequest): Principal {
  const p = request.principal;
  if (!p) {
    throw new Error('[auth] 该路由未经过认证钩子 —— 这是接线错误，不是运行时状况');
  }
  return p;
}

/**
 * scope 校验。
 *
 * `admin` **不隐含**其它权限：一个只做审计的管理端不该顺手拥有发起对话的能力。
 * 需要两种能力就签两个 scope，这比"上级权限自动包含下级"更容易审计。
 */
export function hasScope(principal: Principal, scope: Scope): boolean {
  return principal.scopes.includes(scope);
}

export function requireScope(
  request: FastifyRequest,
  reply: FastifyReply,
  scope: Scope
): Principal | null {
  const principal = principalOf(request);
  if (hasScope(principal, scope)) return principal;

  // 403 而不是 404：调用方拥有这个租户，只是权限不够 ——
  // 他不是在探测别人的资源，给 404 只会让人排查半天
  reply.status(403).send({
    error: {
      code: 'insufficient_scope',
      message: `该操作需要 ${scope} 权限，当前凭证的权限是 [${principal.scopes.join(', ')}]`,
    },
  });
  return null;
}

/** 能否访问指定租户的资源。`admin` 可跨租户（运营后台） */
export function canAccessTenant(principal: Principal, tenantId: string | null): boolean {
  if (hasScope(principal, 'admin')) return true;
  return (tenantId ?? 'anonymous') === principal.tenantId;
}

/**
 * 跨租户访问一律按「不存在」处理。
 *
 * 403 等于确认「**这个 id 存在，只是不属于你**」—— 那就是一个存在性探测接口：
 * 拿它可以枚举出竞争对手有多少会话、多少退款单。
 *
 * 项目里已有同款先例：`/v1/tenants/:id/usage` 对不存在的租户返回全零而不是 404
 * （理由完全一样）。这一版把它变成全局规则。
 */
export function notFound(reply: FastifyReply, code: string, message: string) {
  return reply.status(404).send({ error: { code, message } });
}
