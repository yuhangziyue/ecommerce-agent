import { PgProfileStore, renderProfileContext } from '../../src/store/pg-profile-store.js';
import { createProfileMiddleware } from '../../src/middleware/profile.mw.js';
import { openTestDb, truncateAll } from '../store/helpers.js';
import type { Database, ProfileStore } from '../../src/store/types.js';
import type { TurnContext } from '../../src/core/pipeline.js';

function ctx(): TurnContext {
  return {
    sessionId: 'sesn_test',
    userInput: '你好',
    messages: [],
    systemAppends: [],
    metadata: {},
  };
}

describe('PgProfileStore · 长期记忆（跨会话）', () => {
  let db: Database;
  let profiles: ProfileStore;

  beforeAll(async () => {
    db = await openTestDb();
    profiles = new PgProfileStore(db);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  it('不存在的用户返回 null', async () => {
    expect(await profiles.get('t1', 'nobody')).toBeNull();
  });

  it('upsert 创建画像', async () => {
    const p = await profiles.upsert('t1', 'u1', {
      displayName: '张先生',
      preferences: { deliveryTime: '工作日晚上' },
    });

    expect(p.userId).toBe('u1');
    expect(p.displayName).toBe('张先生');
    expect(p.preferences).toEqual({ deliveryTime: '工作日晚上' });
  });

  it('🔴 preferences 是浅合并而非整体覆盖（否则会抹掉别人写的偏好）', async () => {
    await profiles.upsert('t1', 'u1', { preferences: { deliveryTime: '晚上', invoice: '公司' } });
    await profiles.upsert('t1', 'u1', { preferences: { deliveryTime: '周末' } });

    const p = await profiles.get('t1', 'u1');
    expect(p!.preferences).toEqual({ deliveryTime: '周末', invoice: '公司' });
  });

  it('displayName 不传时不覆盖已有值', async () => {
    await profiles.upsert('t1', 'u1', { displayName: '张先生' });
    await profiles.upsert('t1', 'u1', { preferences: { x: 1 } });

    expect((await profiles.get('t1', 'u1'))!.displayName).toBe('张先生');
  });

  it('addNote 追加备注而非替换', async () => {
    await profiles.addNote('t1', 'u1', '曾投诉物流延迟');
    await profiles.addNote('t1', 'u1', '偏好顺丰');

    expect((await profiles.get('t1', 'u1'))!.notes).toEqual(['曾投诉物流延迟', '偏好顺丰']);
  });

  it('🔴 跨会话可读：会话 A 写入，会话 B 读到（长期记忆的定义）', async () => {
    // 会话 A：某次对话中记录了偏好
    await profiles.upsert('t1', 'u1', { displayName: '李女士', preferences: { 称呼: '女士' } });

    // 会话 B：另一个 store 实例（模拟另一个进程/另一次会话）
    const anotherStore = new PgProfileStore(db);
    const p = await anotherStore.get('t1', 'u1');

    expect(p!.displayName).toBe('李女士');
    expect(p!.preferences).toEqual({ 称呼: '女士' });
  });

  it('不同用户互不影响', async () => {
    await profiles.upsert('t1', 'u1', { displayName: 'A' });
    await profiles.upsert('t1', 'u2', { displayName: 'B' });

    expect((await profiles.get('t1', 'u1'))!.displayName).toBe('A');
    expect((await profiles.get('t1', 'u2'))!.displayName).toBe('B');
  });

  // ============ v1.1 租户隔离 ============
  //
  // v0.7~v1.0 期间 user_profiles 主键是 user_id **单列**。而 user_id 在真实接入中
  // 通常是手机号或会员号 —— 可枚举。下面两条钉住的是一个真实存在过的越权读取。

  it('🔴 租户 B 读不到租户 A 同名 user 的画像（user_id 常常是手机号）', async () => {
    await profiles.upsert('t_acme', '13800138000', {
      displayName: '张先生',
      preferences: { 收货时间: '晚上' },
    });
    await profiles.addNote('t_acme', '13800138000', '曾投诉物流延迟');

    // 修复前：这里拿到的是张先生的姓名、收货偏好和投诉记录
    expect(await profiles.get('t_globex', '13800138000')).toBeNull();
  });

  it('🔴 同一个 user_id 在两个租户下写入互不覆盖', async () => {
    await profiles.upsert('t_acme', 'u_same', { displayName: '甲租户的张先生' });
    await profiles.upsert('t_globex', 'u_same', { displayName: '乙租户的李女士' });

    expect((await profiles.get('t_acme', 'u_same'))!.displayName).toBe('甲租户的张先生');
    expect((await profiles.get('t_globex', 'u_same'))!.displayName).toBe('乙租户的李女士');
  });

  it('🔴 addNote 也按租户隔离（备注是 PII 的重灾区）', async () => {
    await profiles.addNote('t_acme', 'u_same', '甲租户：VIP 客户');
    await profiles.addNote('t_globex', 'u_same', '乙租户：有欠款');

    expect((await profiles.get('t_acme', 'u_same'))!.notes).toEqual(['甲租户：VIP 客户']);
    expect((await profiles.get('t_globex', 'u_same'))!.notes).toEqual(['乙租户：有欠款']);
  });

  it('画像自带租户号，读出来能看出它属于谁', async () => {
    const p = await profiles.upsert('t_acme', 'u1', { displayName: '张先生' });
    expect(p.tenantId).toBe('t_acme');
  });
});

describe('renderProfileContext', () => {
  it('无画像返回 null（不注入空段落）', () => {
    expect(renderProfileContext(null)).toBeNull();
  });

  it('画像为空返回 null', () => {
    expect(
      renderProfileContext({
        tenantId: 't1',
        userId: 'u1',
        displayName: null,
        preferences: {},
        notes: [],
        updatedAt: 0,
      })
    ).toBeNull();
  });

  it('渲染称呼 / 偏好 / 备注', () => {
    const text = renderProfileContext({
      tenantId: 't1',
      userId: 'u1',
      displayName: '张先生',
      preferences: { deliveryTime: '晚上' },
      notes: ['曾投诉物流'],
      updatedAt: 0,
    })!;

    expect(text).toContain('张先生');
    expect(text).toContain('deliveryTime');
    expect(text).toContain('曾投诉物流');
  });
});

describe('profile 中间件', () => {
  let db: Database;
  let profiles: ProfileStore;

  beforeAll(async () => {
    db = await openTestDb();
    profiles = new PgProfileStore(db);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  it('🔴 画像进入 systemAppends（而不是 userInput —— 后者会污染会话历史）', async () => {
    await profiles.upsert('t1', 'u1', { displayName: '张先生' });

    const c = ctx();
    await createProfileMiddleware({ profiles, tenantId: 't1', userId: 'u1' }).beforeTurn!(c);

    expect(c.systemAppends).toHaveLength(1);
    expect(c.systemAppends[0]).toContain('张先生');
    // 用户输入必须原样，画像不能混进历史
    expect(c.userInput).toBe('你好');
  });

  it('无 userId 时不注入（匿名会话）', async () => {
    const c = ctx();
    await createProfileMiddleware({ profiles, tenantId: 't1', userId: undefined }).beforeTurn!(c);
    expect(c.systemAppends).toHaveLength(0);
  });

  it('用户无画像时不注入', async () => {
    const c = ctx();
    await createProfileMiddleware({ profiles, tenantId: 't1', userId: 'never-seen' }).beforeTurn!(c);
    expect(c.systemAppends).toHaveLength(0);
  });

  it('🔴 画像读取失败降级为不注入（长期记忆是增强，不是前置依赖）', async () => {
    const broken: ProfileStore = {
      get: async () => {
        throw new Error('数据库连接断了');
      },
      upsert: async () => {
        throw new Error('x');
      },
      addNote: async () => {
        throw new Error('x');
      },
    };

    const c = ctx();
    const result = await createProfileMiddleware({
      profiles: broken,
      tenantId: 't1',
      userId: 'u1',
    }).beforeTurn!(c);

    expect(result).toEqual({ action: 'continue' }); // 不阻断本轮
    expect(c.systemAppends).toHaveLength(0);
  });
});
