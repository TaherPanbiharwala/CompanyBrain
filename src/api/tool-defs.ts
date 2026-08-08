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
  return ops.map((op) => {
    const inputSchema = zodToJsonSchema(op.params, {
      target: 'jsonSchema7',
      $refStrategy: 'none',
    }) as Record<string, unknown>;

    // Constraints zod cannot express HERE get merged in.
    //
    // The registry's `params` type is z.ZodObject because dispatch calls `.strict()` and redaction
    // reads `.shape` — and `.refine()`, the natural way to write "exactly one of these", returns a
    // ZodEffects that has neither. So a mutually-exclusive param set is enforced in the handler and,
    // without this hook, published as three independent optional fields: an agent reading tools/list
    // is told that `{}` and `{pageId, pageIds}` are both valid calls to an irreversible op.
    //
    // Publishing the constraint is not cosmetic. /api/_ops is unauthenticated (D53) and MCP agents
    // plan against this schema before they ever make a call, so a schema looser than the handler
    // sends them into an avoidable 400 — the same reasoning that made the registry publish
    // additionalProperties:false rather than let a plain z.object silently strip unknown keys.
    return {
      name: op.name,
      description: op.description,
      inputSchema: op.jsonSchemaExtra ? { ...inputSchema, ...op.jsonSchemaExtra } : inputSchema,
    };
  });
}
