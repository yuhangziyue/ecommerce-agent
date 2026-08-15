import { openStores } from '../src/store/index.js';
import { ALL_SCOPES, isScope, type Scope } from '../src/auth/types.js';

/**
 * 签发 / 列出 / 吊销 API Key。
 *
 * ```
 * npm run key:issue  -- --tenant t_acme --scopes chat,read --label 官网客服
 * npm run key:issue  -- --list   --tenant t_acme
 * npm run key:issue  -- --revoke key_xxxx
 * ```
 *
 * **刻意是 CLI 而不是 HTTP 接口**：做成接口就需要另一层 admin 认证来保护它，
 * 而那层认证本身又需要一把钥匙 —— 鸡生蛋。签发走运维通道是这个问题的正解。
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const stores = await openStores(process.env.DATABASE_URL);

  try {
    if (has('revoke')) {
      const keyId = arg('revoke');
      if (!keyId) throw new Error('用法: --revoke <key_id>');
      const ok = await stores.apiKeys.revoke(keyId);
      console.log(ok ? `✓ 已吊销 ${keyId}` : `× ${keyId} 不存在或已经吊销过`);
      return;
    }

    const tenant = arg('tenant');
    if (!tenant) throw new Error('必须指定 --tenant <租户号>');

    if (has('list')) {
      const list = await stores.apiKeys.listByTenant(tenant);
      if (list.length === 0) {
        console.log(`租户 ${tenant} 没有任何凭证`);
        return;
      }
      console.log(`租户 ${tenant} 的凭证：\n`);
      for (const k of list) {
        const state = k.revokedAt ? '已吊销' : '有效';
        const used = k.lastUsedAt ? new Date(k.lastUsedAt).toISOString() : '从未使用';
        console.log(
          `  ${k.keyId}  ${k.prefix}…  [${k.scopes.join(',')}]  ${state}  最近使用: ${used}  ${k.label ?? ''}`
        );
      }
      return;
    }

    const raw = (arg('scopes') ?? 'chat,read').split(',').map((s) => s.trim());
    const invalid = raw.filter((s) => !isScope(s));
    if (invalid.length > 0) {
      throw new Error(
        `未知权限 ${invalid.join(',')}。可用：${ALL_SCOPES.join(', ')}`
      );
    }

    const { record, plaintext } = await stores.apiKeys.issue({
      tenantId: tenant,
      scopes: raw as Scope[],
      label: arg('label'),
    });

    console.log('');
    console.log('  凭证已签发');
    console.log('  ─────────────────────────────────────────────');
    console.log(`  key_id : ${record.keyId}`);
    console.log(`  租户   : ${record.tenantId}`);
    console.log(`  权限   : ${record.scopes.join(', ')}`);
    console.log('');
    console.log(`  ${plaintext}`);
    console.log('');
    // 这句话必须说在前面：库里存的是哈希，我们自己也拿不回明文。
    // 客户丢了钥匙只能重新签发 —— 这是正确的行为，不是缺陷
    console.log('  ⚠️  明文只出现这一次。库里存的是 sha256 哈希，丢了只能重新签发。');
    console.log('  ─────────────────────────────────────────────');
    console.log('');
    console.log(`  curl -X POST localhost:3000/v1/chat/sync \\`);
    console.log(`    -H 'Authorization: Bearer ${plaintext}' \\`);
    console.log(`    -H 'Content-Type: application/json' \\`);
    console.log(`    -d '{"message":"你好"}'`);
    console.log('');
  } finally {
    await stores.close();
  }
}

main().catch((err) => {
  console.error(`✗ ${(err as Error).message}`);
  process.exit(1);
});
