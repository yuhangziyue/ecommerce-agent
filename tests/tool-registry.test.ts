import { ToolRegistry } from '../src/tools/tool-registry.js';
import { AgentTool, ToolResult } from '../src/core/types.js';

function createMockTool(overrides: Partial<AgentTool> = {}): AgentTool {
  return {
    name: 'mock_tool',
    description: 'A mock tool for testing',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
    riskLevel: 'low',
    execute: async (params: any): Promise<ToolResult> => {
      return { content: `executed with query: ${params.query}` };
    },
    ...overrides,
  };
}

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('should register and get a tool', () => {
    const tool = createMockTool();
    registry.register(tool);

    const retrieved = registry.get('mock_tool');
    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe('mock_tool');
    expect(retrieved!.description).toBe('A mock tool for testing');
  });

  it('should return undefined for unregistered tool', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('should return all registered tools via getAll()', () => {
    registry.register(createMockTool({ name: 'tool_a' }));
    registry.register(createMockTool({ name: 'tool_b' }));

    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all.map(t => t.name)).toEqual(expect.arrayContaining(['tool_a', 'tool_b']));
  });

  it('should return tool schemas with name, description, and input_schema', () => {
    const tool = createMockTool();
    registry.register(tool);

    const schemas = registry.getToolSchemas();
    expect(schemas).toHaveLength(1);
    expect(schemas[0]).toEqual({
      name: 'mock_tool',
      description: 'A mock tool for testing',
      input_schema: tool.parameters,
    });
  });

  it('should execute a tool with valid params', async () => {
    registry.register(createMockTool());

    const result = await registry.executeTool('mock_tool', { query: 'hello' });
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('executed with query: hello');
  });

  it('should return error for unknown tool', async () => {
    const result = await registry.executeTool('unknown_tool', {});

    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });

  it('should return validation error for invalid params', async () => {
    registry.register(createMockTool());

    // Missing required 'query' param
    const result = await registry.executeTool('mock_tool', {});

    expect(result.isError).toBe(true);
    expect(result.content).toContain('validation failed');
  });
});
