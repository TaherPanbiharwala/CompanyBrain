import { describe, it, expect } from 'bun:test';
import { buildToolDefs } from '../src/api/tool-defs.ts';
import { operations } from '../src/api/operations.ts';

describe('buildToolDefs — Operation → MCP JSON-Schema', () => {
  it('produces one tool per op with an object inputSchema', () => {
    const defs = buildToolDefs(operations);
    expect(defs.length).toBe(operations.length);
    for (const d of defs) {
      expect(typeof d.name).toBe('string');
      expect(typeof d.description).toBe('string');
      expect((d.inputSchema as { type?: string }).type).toBe('object');
    }
  });

  it('echo (hidden) is excluded when hidden ops are filtered', () => {
    const names = buildToolDefs(operations.filter((o) => !o.hidden)).map((d) => d.name);
    expect(names).not.toContain('echo');
    expect(names).toContain('whoami');
    expect(names).toContain('get_workspace');
    expect(names).toContain('list_members');
  });

  it('echo inputSchema requires a string `message`', () => {
    const echo = buildToolDefs(operations).find((d) => d.name === 'echo')!;
    const schema = echo.inputSchema as { properties?: Record<string, { type?: string }>; required?: string[] };
    expect(schema.properties?.message?.type).toBe('string');
    expect(schema.required).toContain('message');
  });
});
