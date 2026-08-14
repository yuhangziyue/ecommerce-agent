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
