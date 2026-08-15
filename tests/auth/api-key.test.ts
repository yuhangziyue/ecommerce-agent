import { describe, it, expect } from 'vitest';
import {
  generateApiKey,
  hashApiKey,
  parseBearer,
  requestFingerprint,
  safeEqual,
} from '../../src/auth/api-key.js';

describe('API Key 生成与哈希', () => {
  it('明文形如 ak_<env>_<随机>，前缀带环境标记', () => {
    const live = generateApiKey('live');
    const test = generateApiKey('test');

    expect(live.plaintext.startsWith('ak_live_')).toBe(true);
    expect(test.plaintext.startsWith('ak_test_')).toBe(true);
    // 生产 key 误贴进测试配置，肉眼就能拦下来
    expect(live.prefix).not.toBe(test.prefix);
  });

  it('🔴 两次签发不会撞（256 位随机）', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateApiKey().plaintext);
    expect(seen.size).toBe(200);
  });

  it('🔴 落库的前缀不足以还原明文', () => {
    const key = generateApiKey();
    // 前缀只够人辨认「这是哪把钥匙」，离完整明文差着 256 位
    expect(key.plaintext.startsWith(key.prefix)).toBe(true);
    expect(key.plaintext.length).toBeGreaterThan(key.prefix.length + 30);
  });

  it('哈希稳定且单向：同明文同哈希，不同明文不同哈希', () => {
    const a = generateApiKey().plaintext;
    const b = generateApiKey().plaintext;

    expect(hashApiKey(a)).toBe(hashApiKey(a));
    expect(hashApiKey(a)).not.toBe(hashApiKey(b));
    expect(hashApiKey(a)).toHaveLength(64); // sha256 hex
    expect(hashApiKey(a)).not.toContain(a);
  });

  it('safeEqual 长度不同直接 false，不抛异常', () => {
    // timingSafeEqual 对不等长入参会抛错，这里必须先挡住
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('parseBearer', () => {
  it('取出 Bearer 后面的明文', () => {
    expect(parseBearer('Bearer ak_live_x')).toBe('ak_live_x');
  });

  it('scheme 大小写不敏感（RFC 7235）', () => {
    expect(parseBearer('bearer ak_live_x')).toBe('ak_live_x');
    expect(parseBearer('BEARER ak_live_x')).toBe('ak_live_x');
  });

  it('🔴 没带 / 格式错 / 空 token 一律返回 null，不区分', () => {
    // 区分开报只是在告诉攻击者他离对还差几步
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer('')).toBeNull();
    expect(parseBearer('ak_live_x')).toBeNull(); // 少了 scheme
    expect(parseBearer('Basic dXNlcjpwdw==')).toBeNull();
    expect(parseBearer('Bearer ')).toBeNull();
    expect(parseBearer('Bearer   ')).toBeNull();
  });

  it('容忍首尾空白与多余空格', () => {
    expect(parseBearer('  Bearer   ak_live_x  ')).toBe('ak_live_x');
  });
});

describe('requestFingerprint', () => {
  it('🔴 字段顺序不同 → 同一个指纹', () => {
    // 否则调用方只是换了个 JSON 序列化库就会收到莫名其妙的 409
    const a = requestFingerprint({ message: '你好', user_id: 'u1' });
    const b = requestFingerprint({ user_id: 'u1', message: '你好' });
    expect(a).toBe(b);
  });

  it('内容不同 → 指纹不同', () => {
    expect(requestFingerprint({ message: '你好' })).not.toBe(
      requestFingerprint({ message: '你好吗' })
    );
  });

  it('嵌套对象同样做稳定排序', () => {
    const a = requestFingerprint({ a: { x: 1, y: 2 }, b: [1, 2] });
    const b = requestFingerprint({ b: [1, 2], a: { y: 2, x: 1 } });
    expect(a).toBe(b);
  });

  it('🔴 数组顺序**不同**必须视为不同请求', () => {
    // 对象键无序、数组有序 —— 把数组也排序会把两个真正不同的请求判成同一个
    expect(requestFingerprint({ ids: [1, 2] })).not.toBe(
      requestFingerprint({ ids: [2, 1] })
    );
  });

  it('undefined 字段不参与指纹（JSON 里本来就不会出现）', () => {
    expect(requestFingerprint({ a: 1, b: undefined })).toBe(requestFingerprint({ a: 1 }));
  });
});
