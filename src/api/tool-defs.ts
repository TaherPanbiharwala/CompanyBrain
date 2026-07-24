// Operation → MCP tool definition (JSON-Schema inputSchema). Ported from gbrain's src/mcp/tool-defs.ts
// pattern under MIT — see NOTICE. Adapted to zod params via zod-to-json-schema; $refStrategy 'none'
// so the inputSchema is inlined (some MCP clients choke on $ref).
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Operation } from './operations.ts';

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function buildToolDefs(ops: Operation[]): McpToolDef[] {
  return ops.map((op) => ({
    name: op.name,
    description: op.description,
    inputSchema: zodToJsonSchema(op.params, { target: 'jsonSchema7', $refStrategy: 'none' }) as Record<string, unknown>,
  }));
}
