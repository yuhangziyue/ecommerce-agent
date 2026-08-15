import { PGliteDatabase } from '../../src/store/database.js';
import { runMigrations } from '../../src/store/migrations.js';
import type { Database } from '../../src/store/types.js';

describe('迁移机制', () => {
  let db: Database;

  beforeAll(async () => {
    db = await PGliteDatabase.open();
  });

  afterAll(async () => {
    await db.close();
  });

  it('首次执行返回所有迁移名', async () => {
    const executed = await runMigrations(db);
    expect(executed).toEqual(['001_init', '002_sessions_seq']);
  });

  it('重复执行是幂等的（第二次返回空数组，不报错）', async () => {
    const executed = await runMigrations(db);
    expect(executed).toEqual([]);
  });

  it('建出了三张业务表', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`
    );
    const names = rows.map((r) => r.table_name);
    expect(names).toEqual(
      expect.arrayContaining([
        'sessions',
        'session_entries',
        'refund_tickets',
        'schema_migrations',
      ])
    );
  });

  it('refund_tickets.order_id 有唯一约束（幂等的真实执行者）', async () => {
    await db.query(
      `INSERT INTO refund_tickets (refund_id, order_id, amount, reason)
       VALUES ('REF-1', 'ORD-X', 100, 'r')`
    );
    await expect(
      db.query(
        `INSERT INTO refund_tickets (refund_id, order_id, amount, reason)
         VALUES ('REF-2', 'ORD-X', 100, 'r')`
      )
    ).rejects.toThrow();
  });

  it('session_entries 删除会话时级联清理', async () => {
    await db.query(`INSERT INTO sessions (id) VALUES ('s1')`);
    await db.query(
      `INSERT INTO session_entries (session_id, type, data) VALUES ('s1', 'message', '{}'::jsonb)`
    );
    await db.query(`DELETE FROM sessions WHERE id = 's1'`);

    const { rows } = await db.query(
      `SELECT * FROM session_entries WHERE session_id = 's1'`
    );
    expect(rows).toHaveLength(0);
  });

  it('PGlite 引擎标识正确', () => {
    expect(db.engine).toBe('pglite');
  });
});
