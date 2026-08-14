import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, ToolResult } from '../core/types.js';

const HumanHandoffParams = Type.Object({
  reason: Type.String({
    description: '转接原因，说清客户诉求与已尝试的处理，便于人工客服接手',
  }),
  priority: Type.Optional(
    Type.String({
      description: '优先级：high 用于投诉/资金问题，medium 默认，low 用于一般咨询',
      enum: ['low', 'medium', 'high'],
    })
  ),
});
type HumanHandoffParams = Static<typeof HumanHandoffParams>;

const WAIT_TIME: Record<string, string> = {
  high: '1-3 分钟',
  medium: '5-10 分钟',
  low: '10-15 分钟',
};

export const humanHandoffTool: AgentTool<typeof HumanHandoffParams> = {
  name: 'human_handoff',
  description:
    '转接人工客服并创建工单。当问题超出自助处理范围、客户明确要求人工、' +
    '涉及投诉或资金纠纷、或同一问题多轮未解决时调用。',
  parameters: HumanHandoffParams,
  riskLevel: 'medium',
  execute: async (params: HumanHandoffParams): Promise<ToolResult> => {
    const priority = params.priority ?? 'medium';
    const ticketId = `HH-${Date.now()}`;

    return {
      content:
        '已为您创建人工客服转接请求。\n' +
        `工单号: ${ticketId}\n` +
        `转接原因: ${params.reason}\n` +
        `优先级: ${priority}\n` +
        `预计等待时间: ${WAIT_TIME[priority] ?? WAIT_TIME.medium}`,
      metadata: { ticketId, priority },
    };
  },
};
