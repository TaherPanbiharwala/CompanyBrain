// Thin stdio MCP transport (the cuttable final M1 step; DECISIONS D19). Reuses the dispatch spine so
// the same operations are exposed to agents. Structure ported from gbrain's src/mcp/server.ts under
// MIT — see NOTICE. Identity is a SINGLE static operator from env (CB_MCP_*) — a local single-operator
// bridge, NOT a multi-tenant surface; per-workspace MCP token auth is M3 (review AM10).
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildContext, resolveGrants, type OperationContext } from '../core/context.ts';
import { operations } from './operations.ts';
import { buildToolDefs } from './tool-defs.ts';
import { dispatchOp } from './dispatch.ts';

function envContext(): OperationContext {
  const principal = process.env.CB_MCP_PRINCIPAL;
  const workspaceId = process.env.CB_MCP_WORKSPACE;
  const role = process.env.CB_MCP_ROLE ?? 'member';
  if (!principal || !workspaceId) {
    throw new Error('MCP bridge needs CB_MCP_PRINCIPAL and CB_MCP_WORKSPACE (uuids of a real membership).');
  }
  return buildContext({ principal, workspaceId, role, grants: resolveGrants(principal, workspaceId), remote: true });
}

async function main(): Promise<void> {
  const ctx = envContext(); // fail-closed at startup if identity is missing/invalid (before the banner)
  console.error(
    '⚠️  MCP bridge — single static identity from CB_MCP_* env; local single-operator only, not multi-tenant (M3 adds token auth).',
  );
  const visible = operations.filter((o) => !o.hidden); // hidden diagnostics (echo) are not agent tools

  const server = new Server({ name: 'company-brain', version: '0.1.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: buildToolDefs(visible) as any,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await dispatchOp(ctx, req.params.name, req.params.arguments ?? {});
    if (result.ok) {
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(result.error, null, 2) }], isError: true };
  });

  await server.connect(new StdioServerTransport());
}

// Surface any startup failure (missing identity, connect rejection) with a non-zero exit, instead of
// relying on the runtime's unhandled-rejection default (which can leave the process alive but unconnected).
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
