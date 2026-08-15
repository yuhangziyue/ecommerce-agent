import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, ToolContext, ToolResult } from '../core/types.js';
import type { MembershipCard } from '../artifacts/types.js';

interface LevelDef {
  level: MembershipCard['level'];
  label: string;
  minPoints: number;
  discountRate: number;
  benefits: string[];
}

/** 等级表按积分升序 —— `resolveLevel` 依赖这个顺序 */
const LEVELS: LevelDef[] = [
  {
    level: 'bronze',
    label: '青铜会员',
    minPoints: 0,
    discountRate: 1.0,
    benefits: ['生日礼券', '专属客服通道'],
  },
  {
    level: 'silver',
    label: '白银会员',
    minPoints: 1000,
    discountRate: 0.98,
    benefits: ['生日礼券', '专属客服通道', '全场 98 折', '每月 1 张免邮券'],
  },
  {
    level: 'gold',
    label: '黄金会员',
    minPoints: 5000,
    discountRate: 0.95,
    benefits: ['生日礼券', '专属客服通道', '全场 95 折', '无限免邮', '优先发货'],
  },
  {
    level: 'platinum',
    label: '铂金会员',
    minPoints: 20000,
    discountRate: 0.9,
    benefits: [
      '生日礼券',
      '专属客服通道',
      '全场 9 折',
      '无限免邮',
      '优先发货',
      '专属客户经理',
      '退换货免举证',
    ],
  },
];

/**
 * 按积分定级。
 *
 * 抽成纯函数便于把边界值钉死 —— 「恰好 1000 分算不算白银」这类问题
 * 是会员体系里最容易扯皮的地方，用例里必须有它。
 */
export function resolveLevel(points: number): {
  def: LevelDef;
  pointsToNextLevel: number | null;
} {
  // 从高到低找第一个够格的
  const idx = [...LEVELS].reverse().findIndex((l) => points >= l.minPoints);
  const def = LEVELS[LEVELS.length - 1 - idx];
  const next = LEVELS[LEVELS.length - idx];

  return {
    def,
    pointsToNextLevel: next ? next.minPoints - points : null,
  };
}

/**
 * 从用户 id 推一个稳定的积分数。
 *
 * 真实系统读会员库；这里用哈希是为了**同一用户每次查到的积分一致** ——
 * 用随机数会让「刚才还是黄金会员，再问一次变白银」，比没有这个功能更糟。
 */
function pointsOf(userId: string): number {
  let h = 0;
  for (let i = 0; i < userId.length; i++) {
    h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return h % 30000;
}

const MembershipParams = Type.Object({
  userId: Type.Optional(
    Type.String({ description: '要查询的用户 id；不传则用当前会话的用户' })
  ),
});
type MembershipParams = Static<typeof MembershipParams>;

export const membershipInfoTool: AgentTool<typeof MembershipParams> = {
  name: 'membership_info',
  description:
    '查询会员等级、积分与权益。客户问「我是什么会员」「有什么权益」「怎么升级」时使用。',
  parameters: MembershipParams,
  riskLevel: 'low',
  execute: async (params: MembershipParams, ctx?: ToolContext): Promise<ToolResult> => {
    const userId = params.userId ?? ctx?.userId ?? '';
    if (!userId) {
      return {
        content: '当前会话没有关联用户，无法查询会员信息。请客户登录后再试。',
        isError: true,
      };
    }

    const points = pointsOf(userId);
    const { def, pointsToNextLevel } = resolveLevel(points);

    const card: MembershipCard = {
      userId,
      level: def.level,
      levelLabel: def.label,
      points,
      pointsToNextLevel,
      benefits: def.benefits,
      discountRate: def.discountRate,
    };

    return {
      content:
        `会员信息：\n` +
        `等级: ${def.label}\n` +
        `积分: ${points}\n` +
        (pointsToNextLevel === null
          ? '已是最高等级。\n'
          : `距下一等级还需 ${pointsToNextLevel} 积分。\n`) +
        `折扣: ${def.discountRate === 1 ? '无折扣' : `${(def.discountRate * 10).toFixed(1)} 折`}\n` +
        `权益: ${def.benefits.join('、')}`,
      artifact: { type: 'membership', data: card },
      metadata: { level: def.level, points },
    };
  },
};
