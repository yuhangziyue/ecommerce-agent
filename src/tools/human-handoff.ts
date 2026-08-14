import { AgentTool, ToolResult } from '../core/types.js';

export const humanHandoffTool: AgentTool = {
  name: 'human_handoff',
  description: '转接人工客服',
  parameters: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: '转接原因' },
      priority: { type: 'string', enum: ['low', 'medium', 'high'], description: '优先级' },
    },
    required: ['reason'],
  },
  riskLevel: 'medium',
  execute: async (params: { reason: string; priority?: string }): Promise<ToolResult> => {
    const priority = params.priority || 'medium';
    const ticketId = `HH-${Date.now()}`;

    return {
      content: `已为您创建人工客服转接请求。\n工单号: ${ticketId}\n转接原因: ${params.reason}\n优先级: ${priority}\n预计等待时间: ${priority === 'high' ? '1-3分钟' : '5-10分钟'}`,
      metadata: { ticketId, priority },
    };
  },
};
