import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * API Key 的生成与校验。
 *
 * 全部是纯函数（除了取随机数），因为这是整个鉴权链路里**最不该出错**的一环，
 * 而纯函数是唯一能被彻底测穿的形态。
 */

const PREFIX = 'ak';
/** 32 字节 = 256 位随机。够长到不用考虑碰撞与爆破 */
const SECRET_BYTES = 32;

export interface GeneratedKey {
  /** 只在签发那一刻存在。**不落库、不打日志** */
  plaintext: string;
  hash: string;
  /** 给人看的辨认前缀（`ak_live_a1b2c3`），落库 */
  prefix: string;
}

/**
 * 签发一把新钥匙。
 *
 * 明文形如 `ak_live_<43 个 base64url 字符>`。前缀带环境标记是刻意的：
 * 生产 key 误贴进测试配置这类事故，肉眼就能拦下来一半。
 */
export function generateApiKey(env: 'live' | 'test' = 'live'): GeneratedKey {
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  const plaintext = `${PREFIX}_${env}_${secret}`;
  return {
    plaintext,
    hash: hashApiKey(plaintext),
    prefix: plaintext.slice(0, PREFIX.length + env.length + 8),
  };
}

/**
 * 单向哈希。
 *
 * 用 sha256 而不是 bcrypt/argon2：API Key 是 256 位**高熵随机串**，
 * 不是人选的密码——它没有字典可以撞，慢哈希在这里只买到延迟，买不到安全。
 * （用户密码是另一回事，那必须用慢哈希。）
 */
export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/**
 * 定长比较。
 *
 * 这里其实已经用哈希做过一次归一化，长度恒定，`===` 的时序泄露量微乎其微；
 * 但凭证比较用定长比较是**不需要每次重新论证的默认动作**，
 * 一旦哪天有人把它改成比较明文，这个函数还在原地挡着。
 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * 从 `Authorization` 头里取出明文 key。
 *
 * 只接受 `Bearer <token>`，且 scheme 大小写不敏感（RFC 7235 规定 scheme 是
 * 大小写不敏感的，一些 SDK 会发 `bearer`）。取不到返回 null ——
 * **不区分「没带」和「格式错」**：两者对调用方都是同一句「凭证无效」，
 * 分开报只是在告诉攻击者他离对还差几步。
 */
export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const trimmed = header.trim();
  const sp = trimmed.indexOf(' ');
  if (sp < 0) return null;
  if (trimmed.slice(0, sp).toLowerCase() !== 'bearer') return null;
  const token = trimmed.slice(sp + 1).trim();
  return token.length > 0 ? token : null;
}

/**
 * 请求体指纹，用于幂等键的「同 key 是否同一个请求」判定。
 *
 * 对象键排序后再序列化 —— 否则同一个请求因为 JSON 字段顺序不同
 * 就被判成"不同请求"，调用方会收到莫名其妙的 409。
 */
export function requestFingerprint(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
