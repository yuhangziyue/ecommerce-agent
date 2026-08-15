import type { Intent } from '../intent/types.js';

/**
 * 领域 Agent = 提示词 + 工具子集 + 意图归属。
 *
 * 拆分的三个理由（对应单体 Agent 的三个具体问题）：
 * 1. 提示词互相稀释 —— 退款的严谨、售前的话术、投诉的安抚挤在一份 prompt 里，
 *    加得越多每条越不被遵守
 * 2. 工具面过宽 —— 客户问「有什么好耳机」时 `refund_apply` 也在列表里，
 *    而选错高风险工具的代价不对称
 * 3. 无法差异化配置 —— 售前可以用便宜快的模型，退款必须用最强的
 */
export interface DomainAgent {
  id: string;
  name: string;
  description: string;
  /** 该领域负责哪些意图 */
  intents: Intent[];
  /** 只写本领域特有的规则；基础规则留在全局 SYSTEM_PROMPT，避免重复与冲突 */
  systemPrompt: string;
  /** 本轮可见的工具名；空数组表示**全部工具**（兜底 Agent 用） */
  toolNames: string[];
}
