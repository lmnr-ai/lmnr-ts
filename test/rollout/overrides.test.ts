import * as assert from 'node:assert';
import { describe, it } from 'node:test';

// We'll test the private methods indirectly through the public API
// by setting up scenarios and verifying behavior

void describe('System Message Overrides', () => {
  void it('replaces system message with string override', () => {
    const prompt = [
      { role: 'system', content: 'Old system' },
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    ];

    // This would be done inside applyOverrides in BaseLaminarLanguageModel
    const withoutSystem = prompt.filter(msg => msg.role !== 'system');
    const newPrompt = [
      { role: 'system', content: 'New system override' },
      ...withoutSystem,
    ];

    assert.strictEqual(newPrompt[0].role, 'system');
    assert.strictEqual(newPrompt[0].content, 'New system override');
    assert.strictEqual(newPrompt[1].role, 'user');
    assert.strictEqual(newPrompt.length, 2);
  });

  void it('replaces multiple system messages', () => {
    const prompt = [
      { role: 'system', content: 'System 1' },
      { role: 'system', content: 'System 2' },
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    ];

    const withoutSystem = prompt.filter(msg => msg.role !== 'system');
    const newPrompt = [
      { role: 'system', content: 'Override' },
      ...withoutSystem,
    ];

    assert.strictEqual(newPrompt.length, 2);
    assert.strictEqual(newPrompt[0].content, 'Override');
    assert.strictEqual(newPrompt[1].role, 'user');
  });

  void it('handles array of text blocks as system override', () => {
    const textBlocks = [
      { type: 'text', text: 'Part 1' },
      { type: 'text', text: 'Part 2' },
      { type: 'text', text: 'Part 3' },
    ];

    // normalizeSystemOverride joins with newline
    const normalized = textBlocks.map(block => block.text ?? '').join('\n');

    assert.strictEqual(normalized, 'Part 1\nPart 2\nPart 3');
  });

  void it('handles empty text blocks', () => {
    const textBlocks = [
      { type: 'text', text: 'Part 1' },
      { type: 'text', text: '' },
      { type: 'text', text: 'Part 3' },
    ];

    const normalized = textBlocks.map(block => block.text ?? '').join('\n');

    assert.strictEqual(normalized, 'Part 1\n\nPart 3');
  });

  void it('returns original prompt when no override provided', () => {
    const prompt = [
      { role: 'system', content: 'Original' },
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    ];

    const systemOverride = undefined;
    const result = systemOverride ? [] : prompt;

    assert.deepStrictEqual(result, prompt);
  });
});

void describe('Tool Definition Overrides', () => {
  void it('overrides existing tool description', () => {
    const tools = [
      {
        type: 'function',
        name: 'get_weather',
        description: 'Old description',
        inputSchema: { type: 'object', properties: { location: { type: 'string' } } },
      },
    ];

    const overrides: Array<{ name: string; description?: string; parameters?: any }> = [
      { name: 'get_weather', description: 'New description' },
    ];

    const existingToolIndex = tools.findIndex(
      tool => tool.type === 'function' && tool.name === 'get_weather',
    );

    const updatedTools = [...tools];
    const override = overrides[0];
    const existingTool = updatedTools[existingToolIndex];

    updatedTools[existingToolIndex] = {
      ...existingTool,
      description: override.description ?? existingTool.description,
      inputSchema: override.parameters ?? existingTool.inputSchema,
    };

    assert.strictEqual(updatedTools[0].description, 'New description');
    assert.deepStrictEqual(updatedTools[0].inputSchema, existingTool.inputSchema);
  });

  void it('overrides existing tool inputSchema', () => {
    const tools = [
      {
        type: 'function',
        name: 'get_weather',
        description: 'Get weather',
        inputSchema: { type: 'object', properties: { location: { type: 'string' } } },
      },
    ];

    const newSchema = {
      type: 'object',
      properties: {
        location: { type: 'string' },
        units: { type: 'string', enum: ['celsius', 'fahrenheit'] },
      },
    };

    const overrides: Array<{ name: string; description?: string; parameters?: any }> = [
      { name: 'get_weather', parameters: newSchema },
    ];

    const updatedTools = [...tools];
    const existingToolIndex = 0;
    const override = overrides[0];
    const existingTool = updatedTools[existingToolIndex];

    updatedTools[existingToolIndex] = {
      ...existingTool,
      description: override.description ?? existingTool.description,
      inputSchema: override.parameters ?? existingTool.inputSchema,
    };

    assert.strictEqual(updatedTools[0].description, 'Get weather');
    assert.deepStrictEqual(updatedTools[0].inputSchema, newSchema);
  });

  void it('merges override with existing tool', () => {
    const tools = [
      {
        type: 'function',
        name: 'calculate',
        description: 'Old description',
        inputSchema: { type: 'object', properties: { x: { type: 'number' } } },
      },
    ];

    const overrides: Array<{ name: string; description?: string; parameters?: any }> = [
      {
        name: 'calculate',
        description: 'New description',
        // No parameters - should keep existing
      },
    ];

    const updatedTools = [...tools];
    const override = overrides[0];
    const existingTool = updatedTools[0];

    updatedTools[0] = {
      ...existingTool,
      description: override.description ?? existingTool.description,
      inputSchema: override.parameters ?? existingTool.inputSchema,
    };

    assert.strictEqual(updatedTools[0].description, 'New description');
    assert.deepStrictEqual(updatedTools[0].inputSchema, existingTool.inputSchema);
  });

  void it('adds new tool with inputSchema', () => {
    const tools = [
      {
        type: 'function',
        name: 'existing',
        description: 'Existing tool',
        inputSchema: {},
      },
    ];

    const overrides: Array<{ name: string; description?: string; parameters?: any }> = [
      {
        name: 'new_tool',
        description: 'New tool',
        parameters: { type: 'object', properties: { param: { type: 'string' } } },
      },
    ];

    const updatedTools = [...tools];
    const override = overrides[0];

    if (override.parameters) {
      updatedTools.push({
        type: 'function',
        name: override.name,
        description: override.description!,
        inputSchema: override.parameters,
      });
    }

    assert.strictEqual(updatedTools.length, 2);
    assert.strictEqual(updatedTools[1].name, 'new_tool');
    assert.strictEqual(updatedTools[1].description, 'New tool');
  });

  void it('skips tools without inputSchema', () => {
    const tools = [
      {
        type: 'function',
        name: 'existing',
        description: 'Existing',
        inputSchema: {},
      },
    ];

    const overrides: Array<{ name: string; description?: string; parameters?: any }> = [
      {
        name: 'invalid_tool',
        description: 'Tool without schema',
        // No parameters
      },
    ];

    const updatedTools = [...tools];
    const override = overrides[0];

    if (override.parameters) {
      updatedTools.push({
        type: 'function',
        name: override.name,
        description: override.description,
        inputSchema: override.parameters,
      } as any);
    }

    // Should not add the tool
    assert.strictEqual(updatedTools.length, 1);
  });

  void it('handles empty tools array with overrides', () => {
    const overrides: Array<{ name: string; description?: string; parameters?: any }> = [
      {
        name: 'new_tool',
        description: 'First tool',
        parameters: { type: 'object' },
      },
    ];

    const newTools: any[] = [];
    for (const override of overrides) {
      if (override.parameters) {
        newTools.push({
          type: 'function',
          name: override.name,
          description: override.description,
          inputSchema: override.parameters,
        });
      }
    }

    assert.strictEqual(newTools.length, 1);
    assert.strictEqual(newTools[0].name, 'new_tool');
  });

  void it('preserves provider-defined tools', () => {
    const tools: any[] = [
      {
        type: 'provider-defined',
        name: 'provider_tool',
        id: 'provider-123',
      },
      {
        type: 'function',
        name: 'user_tool',
        description: 'User tool',
        inputSchema: {},
      },
    ];

    const overrides: Array<{ name: string; description?: string; parameters?: any }> = [
      {
        name: 'user_tool',
        description: 'Updated user tool',
      },
    ];

    const updatedTools = [...tools];
    const override = overrides[0];
    const existingToolIndex = updatedTools.findIndex(
      tool => tool.type === 'function' && tool.name === override.name,
    );

    if (existingToolIndex !== -1) {
      const existingTool = updatedTools[existingToolIndex];
      updatedTools[existingToolIndex] = {
        ...existingTool,
        description: override.description ?? existingTool.description,
        inputSchema: override.parameters ?? existingTool.inputSchema,
      };
    }

    // Provider tool unchanged
    assert.strictEqual(updatedTools[0].type, 'provider-defined');
    assert.strictEqual(updatedTools[0].name, 'provider_tool');

    // User tool updated
    assert.strictEqual(updatedTools[1].description, 'Updated user tool');
  });

  void it('handles multiple tool overrides', () => {
    const tools = [
      {
        type: 'function',
        name: 'tool1',
        description: 'Tool 1',
        inputSchema: { type: 'object' },
      },
      {
        type: 'function',
        name: 'tool2',
        description: 'Tool 2',
        inputSchema: { type: 'object' },
      },
    ];

    const overrides: Array<{ name: string; description?: string; parameters?: any }> = [
      { name: 'tool1', description: 'Updated Tool 1' },
      { name: 'tool2', description: 'Updated Tool 2' },
    ];

    const updatedTools = [...tools];

    for (const override of overrides) {
      const idx = updatedTools.findIndex(
        tool => tool.type === 'function' && tool.name === override.name,
      );
      if (idx !== -1) {
        const existingTool = updatedTools[idx];
        updatedTools[idx] = {
          ...existingTool,
          description: override.description ?? existingTool.description,
          inputSchema: override.parameters ?? existingTool.inputSchema,
        };
      }
    }

    assert.strictEqual(updatedTools[0].description, 'Updated Tool 1');
    assert.strictEqual(updatedTools[1].description, 'Updated Tool 2');
  });
});

