import type { Database, ProfileStore, UserProfile } from './types.js';

interface ProfileRow {
  user_id: string;
  display_name: string | null;
  preferences: Record<string, unknown>;
  notes: string[];
  updated_at: string | Date;
}

function toProfile(row: ProfileRow): UserProfile {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    preferences: row.preferences ?? {},
    notes: row.notes ?? [],
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.getTime()
        : Date.parse(row.updated_at),
  };
}

const COLUMNS = 'user_id, display_name, preferences, notes, updated_at';

/**
 * 长期记忆：跨会话的用户画像。
 *
 * 与短期滑窗、中期摘要的区别在于**生命周期**：它不属于任何一次会话，
 * 客户明天再来时称呼、收货偏好、历史投诉都还在。
 */
export class PgProfileStore implements ProfileStore {
  constructor(private readonly db: Database) {}

  async get(userId: string): Promise<UserProfile | null> {
    const { rows } = await this.db.query<ProfileRow>(
      `SELECT ${COLUMNS} FROM user_profiles WHERE user_id = $1`,
      [userId]
    );
    return rows[0] ? toProfile(rows[0]) : null;
  }

  /**
   * 局部更新。`preferences` 做**浅合并**（`||` 运算符）而不是整体覆盖 ——
   * 调用方通常只知道自己关心的那几个字段，整体覆盖会把别人写的偏好抹掉。
   */
  async upsert(
    userId: string,
    patch: { displayName?: string; preferences?: Record<string, unknown> }
  ): Promise<UserProfile> {
    const { rows } = await this.db.query<ProfileRow>(
      `INSERT INTO user_profiles (user_id, display_name, preferences)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (user_id) DO UPDATE SET
         display_name = COALESCE(EXCLUDED.display_name, user_profiles.display_name),
         preferences  = user_profiles.preferences || EXCLUDED.preferences,
         updated_at   = now()
       RETURNING ${COLUMNS}`,
      [userId, patch.displayName ?? null, JSON.stringify(patch.preferences ?? {})]
    );
    return toProfile(rows[0]);
  }

  async addNote(userId: string, note: string): Promise<UserProfile> {
    const { rows } = await this.db.query<ProfileRow>(
      `INSERT INTO user_profiles (user_id, notes)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (user_id) DO UPDATE SET
         notes      = user_profiles.notes || $2::jsonb,
         updated_at = now()
       RETURNING ${COLUMNS}`,
      [userId, JSON.stringify([note])]
    );
    return toProfile(rows[0]);
  }
}

/** 把画像渲染成注入 system prompt 的一段文字；无内容时返回 null（不注入空段落） */
export function renderProfileContext(profile: UserProfile | null): string | null {
  if (!profile) return null;

  const lines: string[] = [];
  if (profile.displayName) lines.push(`称呼：${profile.displayName}`);

  const prefs = Object.entries(profile.preferences);
  if (prefs.length > 0) {
    lines.push(
      `偏好：${prefs.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('；')}`
    );
  }
  if (profile.notes.length > 0) {
    lines.push(`历史备注：${profile.notes.join('；')}`);
  }

  if (lines.length === 0) return null;
  return `## 关于这位客户（跨会话记忆）\n${lines.join('\n')}`;
}
