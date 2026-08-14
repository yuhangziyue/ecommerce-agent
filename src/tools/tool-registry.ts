import { AgentTool, ToolResult } from '../core/types.js';
import Ajv from 'ajv';

const ajv = new Ajv();

export class ToolRegistry {
  private tools: Map<string, AgentTool> = new Map();

  /** Register a tool */
  register(tool: AgentTool): void {
    this.tools.set(tool.name, tool);
  }

  /** Get a tool by name */
  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  /** Get all registered tools */
  getAll(): AgentTool[] {
    return Array.from(this.tools.values());
  }

  /** Get tool schemas in Anthropic API format */
  getToolSchemas(): Array<{
    name: string;
    description: string;
    input_schema: any;
  }> {
    return this.getAll().map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }

  /**
   * 只做参数校验，不执行。
   *
   * AgentLoop 需要「校验通过 → 高风险确认 → 才执行」这个顺序，
   * 所以校验必须能独立于执行调用；否则确认弹窗会出现在参数都不合法的调用上。
   */
  validate(
    name: string,
    params: Record<string, unknown>
  ): { ok: true } | { ok: false; error: string } {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, error: `Tool "${name}" not found` };
    }

    const validateFn = ajv.compile(tool.parameters);
    if (!validateFn(params)) {
      return { ok: false, error: ajv.errorsText(validateFn.errors) };
    }

    return { ok: true };
  }

  /** Execute a tool by name with params, validates params against schema */
  async executeTool(name: string, params: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { content: `Tool "${name}" not found`, isError: true };
    }

    // Validate params against schema
    const validate = ajv.compile(tool.parameters);
    if (!validate(params)) {
      return {
        content: `Parameter validation failed: ${ajv.errorsText(validate.errors)}`,
        isError: true,
      };
    }

    try {
      return await tool.execute(params);
    } catch (error: any) {
      return { content: `Tool execution error: ${error.message}`, isError: true };
    }
  }
}
