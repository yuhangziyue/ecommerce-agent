import type { AgentTool, ToolContext, ToolResult } from '../core/types.js';
import type { ToolRegistry } from './tool-registry.js';

/**
 * 工具描述符 —— **能跨进程传输的部分**。
 *
 * 注意这里**没有 `execute`**：那是个函数引用，跨不了网络。
 * v0.15 之前 AgentLoop 直接持有 `AgentTool` 并调用 `tool.execute()`，
 * 这一个字段就把工具和编排绑死在同一个进程里 —— 不是性能问题，是架构死结。
 */
export interface ToolDescriptor {
  name: string;
  description: string;
  /** JSON Schema（TypeBox 产出的就是 JSON Schema，天然可序列化） */
  parameters: unknown;
  /**
   * 风险等级必须**随描述符过来**。
   * 它决定要不要走 v0.12 的异步确认流，而那是**编排层**的决策 ——
   * 如果只有工具服务知道风险等级，编排层就没法拦。
   */
  riskLevel: AgentTool['riskLevel'];
}

/** 与 `ToolRegistry.validate` 同形，避免在两处维护两套结果类型 */
export type ValidationResult = { ok: true } | { ok: false; error: string };

/**
 * 工具网关。AgentLoop 依赖它而不是 `ToolRegistry` 具体类。
 *
 * 判据很简单：**把中间换成网络，还能不能跑**。
 * 换不了，说明之前所谓的分层只是文件夹的分法。
 */
export interface ToolGateway {
  /** 本进程/远端可用的工具清单 */
  list(): Promise<ToolDescriptor[]>;
  get(name: string): Promise<ToolDescriptor | undefined>;
  validate(name: string, input: Record<string, unknown>): Promise<ValidationResult>;
  execute(
    name: string,
    input: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolResult>;
}

/**
 * 本地网关：包住现有 `ToolRegistry`。
 *
 * 存在的意义是**让单进程模式的语义一字不变** —— 拆分不该顺带改行为，
 * 否则一旦出问题就分不清是拆坏的还是本来就坏的。
 */
export class LocalToolGateway implements ToolGateway {
  constructor(private readonly registry: ToolRegistry) {}

  async list(): Promise<ToolDescriptor[]> {
    return this.registry.getAll().map(describe);
  }

  async get(name: string): Promise<ToolDescriptor | undefined> {
    const tool = this.registry.get(name);
    return tool ? describe(tool) : undefined;
  }

  async validate(
    name: string,
    input: Record<string, unknown>
  ): Promise<ValidationResult> {
    return this.registry.validate(name, input);
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolResult> {
    const tool = this.registry.get(name);
    if (!tool) {
      return { content: `工具 ${name} 不存在。`, isError: true };
    }
    return tool.execute(input, ctx);
  }
}

export function describe(tool: AgentTool): ToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    riskLevel: tool.riskLevel,
  };
}

/**
 * 生成链路号。
 *
 * v1.2：改用 **W3C trace context 规格**（32/16 位十六进制）。
 * 在此之前是 `tr_<base36>` —— 好认，但没法放进 `traceparent`；
 * 而工具服务日后可能被别的系统调用，自造格式等于把链路锁死在自家生态里。
 *
 * 实现统一收在 `observability/tracing.ts`，这里只转发 ——
 * 两个地方各生成一份 id 是「同一件事有两个真相」的经典开头。
 */
export { newTraceId, newSpanId } from '../observability/tracing.js';
