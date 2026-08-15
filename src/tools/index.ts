import type { AgentTool } from '../core/types.js';
import { ToolRegistry } from './tool-registry.js';
import { orderLookupTool } from './order-lookup.js';
import { productSearchTool } from './product-search.js';
import { faqSearchTool } from './faq-search.js';
import { refundApplyTool } from './refund-apply.js';
import { humanHandoffTool } from './human-handoff.js';
import { returnRequestTool, flowStatusTool } from './return-request.js';
import { logisticsCheckTool } from './logistics-check.js';

export { ToolRegistry } from './tool-registry.js';
export { orderLookupTool } from './order-lookup.js';
export { productSearchTool } from './product-search.js';
export { faqSearchTool } from './faq-search.js';
export { refundApplyTool } from './refund-apply.js';
export { humanHandoffTool } from './human-handoff.js';
export { returnRequestTool, flowStatusTool, setFlowEngine } from './return-request.js';
export { logisticsCheckTool, judgeLogistics } from './logistics-check.js';

/**
 * 全部工具的单一注册入口。
 *
 * v0.2 之前 index.ts 内联定义了另一套同功能工具（query_order / search_products / ...），
 * 与 src/tools/ 下这套并存：内联那套在跑但零测试，这套有测试但运行时零引用。
 * 现在统一到这里 —— 「被测的」和「在跑的」是同一套。
 */
export const ALL_TOOLS: AgentTool[] = [
  orderLookupTool as AgentTool,
  productSearchTool as AgentTool,
  faqSearchTool as AgentTool,
  refundApplyTool as AgentTool,
  humanHandoffTool as AgentTool,
  // v0.12 电商场景 I
  returnRequestTool as AgentTool,
  flowStatusTool as AgentTool,
  logisticsCheckTool as AgentTool,
];

export function buildToolRegistry(tools: AgentTool[] = ALL_TOOLS): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) {
    registry.register(tool);
  }
  return registry;
}
