// Thin stdio MCP transport (the cuttable final M1 step; DECISIONS D19). Reuses the dispatch spine so
// the same operations are exposed to agents. Structure ported from gbrain's src/mcp/server.ts under
// MIT — see NOTICE. Identity is a SINGLE static operator from env (CB_MCP_*) — a local
// single-operator bridge, NOT a multi-tenant surface; per-workspace MCP token auth is M3 (review AM10).
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildContext, resolveGrants, type OperationContext } from '../core/context.ts';
import { assertMembership } from '../auth/membership.ts';
import { operations } from './operations.ts';
import { buildToolDefs } from './tool-defs.ts';
import { dispatchOp } from './dispatch.ts';

/** Which principal and workspace — from env. The ROLE is never taken from env (D39). */
export async function envContext(): Promise<OperationContext> {
  const principal = process.env.CB_MCP_PRINCIPAL;
  const workspaceId = process.env.CB_MCP_WORKSPACE;
  if (!principal || !workspaceId) {
    throw new Error('MCP bridge needs CB_MCP_PRINCIPAL and CB_MCP_WORKSPACE (uuids of a real membership).');
  }
  // D25 on the agent surface: the pair must be a real membership, and the role comes from the
  // database, not from CB_MCP_ROLE (which no longer exists).
  const role = await assertMembership(principal, workspaceId);
  return buildContext({ principal, workspaceId, role, grants: resolveGrants(principal, workspaceId), remote: true });
}

// ── Identity freshness ────────────────────────────────────────────────────
// The bridge used to resolve identity ONCE at process start and reuse that context for the life of
// the process. Under M1 that was honest: the role came from CB_MCP_ROLE, a static env var, so a
// cached copy and a fresh read were the same thing. M2 replaced it with assertMembership(), a real
// database read — which made the code LOOK authoritative while it was in fact frozen forever.
//
// The consequence: removing a principal from workspace_members, or demoting owner→admin→member, had
// no effect on a running bridge. MCP hosts keep stdio processes alive for days. Meanwhile the HTTP
// path re-reads the membership row on every single request via cb_internal.resolve_session — so the
// two surfaces disagreed about whether revocation is enforced, and the AGENT surface was the
// permissive one.
//
// A short TTL rather than a read per call: this is a trusted-local single-operator bridge, the read
// costs an intercontinental round trip, and a 30-second window to notice a revocation is a
// reasonable trade for not paying that on every tool call. Revocation now takes effect without
// restarting the bridge, which is the property that was missing.
const CONTEXT_TTL_MS = 30_000;
let cached: { ctx: OperationContext; at: number } | null = null;

/** Test hook: forget the memoized identity. */
export function resetContextCache(): void {
  cached = null;
}

export async function currentContext(now: number = Date.now()): Promise<OperationContext> {
  if (cached && now - cached.at < CONTEXT_TTL_MS) return cached.ctx;
  const ctx = await envContext();
  cached = { ctx, at: now };
  return ctx;
}

// ── Handlers, built independently of the transport so they are testable ──
// `main()` used to run at module load, which made this file impossible to import from a test without
// booting a stdio server — so the whole transport, including the assertMembership fail-closed guard,
// had zero coverage.

export interface McpHandlers {
  listTools(): Promise<{ tools: unknown[] }>;
  callTool(req: { params: { name: string; arguments?: unknown } }): Promise<{
    content: { type: 'text'; text: string }[];
    isError?: boolean;
  }>;
}

export function buildHandlers(): McpHandlers {
  const visible = operations.filter((o) => !o.hidden); // hidden diagnostics (echo) are not agent tools
  return {
    async listTools() {
      return { tools: buildToolDefs(visible) };
    },
    async callTool(req) {
      // Identity is resolved HERE, per call (TTL-memoized), not once at boot.
      let ctx: OperationContext;
      try {
        ctx = await currentContext();
      } catch (err) {
        // A revoked membership, a demoted role, or a database blip must NOT throw out of the
        // handler — that would tear down the stdio loop and take the whole bridge with it. Report it
        // as a tool error and let the agent see why.
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ code: 'unauthenticated', message: String((err as Error).message) }, null, 2) }],
          isError: true,
        };
      }
      const result = await dispatchOp(ctx, req.params.name, req.params.arguments ?? {});
      if (result.ok) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
      }
      // retryAfter is merged in, not dropped. This is the lane the budget exists for — an agent in a
      // loop, with no human reading an HTTP header — and serializing `result.error` alone handed it
      // "too many requests" with no interval, which is an invitation to hot-retry. There is no header
      // channel over stdio, so the number has to ride in the payload or it does not reach the caller
      // at all (D94).
      const payload = result.retryAfter === undefined
        ? result.error
        : { ...result.error, retryAfterSeconds: result.retryAfter };
      return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }], isError: true };
    },
  };
}

async function main(): Promise<void> {
  await envContext(); // fail-closed at startup if identity is missing/invalid or not a membership
  console.error(
    '⚠️  MCP bridge — single static identity from CB_MCP_* env; local single-operator only, not multi-tenant (M3 adds token auth).',
  );

  const handlers = buildHandlers();
  const server = new Server({ name: 'company-brain', version: '0.1.0' }, { capabilities: { tools: {} } });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.setRequestHandler(ListToolsRequestSchema, async () => (await handlers.listTools()) as any);
  server.setRequestHandler(CallToolRequestSchema, async (req) => handlers.callTool(req));

  await server.connect(new StdioServerTransport());
}

// Only when run as the entrypoint (`bun run mcp`). Guarding this is what lets a test import the
// handlers above without starting a server on stdio.
if (import.meta.main) {
  // Surface any startup failure (missing identity, connect rejection) with a non-zero exit, instead
  // of relying on the runtime's unhandled-rejection default (which can leave the process alive but
  // unconnected).
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
