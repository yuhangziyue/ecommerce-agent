import { PGliteDatabase } from '../../src/store/database.js';
import { runMigrations, truncateAll } from '../../src/store/migrations.js';
import type { Database } from '../../src/store/types.js';

/**
 * 每个测试**文件**共享一个 PGlite 实例。
 *
 * 实测创建一个实例要 450–780ms —— 每个用例新建会让测试时长失控。
 * 隔离靠 `beforeEach` 的 TRUNCATE，不靠新建实例。
 */
export async function openTestDb(): Promise<Database> {
  const db = await PGliteDatabase.open(); // 纯内存，不落盘
  await runMigrations(db);
  return db;
}

export { truncateAll };
