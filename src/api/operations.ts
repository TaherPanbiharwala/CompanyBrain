// Ops-as-data registry. The single source every transport (REST /api/:op, stdio MCP) generates from.
// Registry/dispatch pattern ported from gbrain's src/core/operations.ts under MIT — see NOTICE.
// Adapted: params are zod schemas (D21) instead of gbrain's ParamDef; the context is company-brain's
// tenant identity (src/core/context.ts); handlers open their own withScopedTx for DB work (D6).
import { z } from 'zod';
import type { OperationContext } from '../core/context.ts';
import type { Role } from './roles.ts';
import { withScopedTx } from '../db/client.ts';
import { OperationError } from './errors.ts';

/** A registered operation (type-erased so a heterogeneous registry stays homogeneous). Define via
 *  defineOp so per-op params stay type-safe at the definition site. */
export interface Operation {
  name: string;
  description: string;
  params: z.ZodObject<z.ZodRawShape>; // z.object → keyed redaction (.shape) + MCP inputSchema (AM2)
  requiredRole?: Role; // default 'member'
  mutating?: boolean; // read vs write (log + future routing)
  hidden?: boolean; // excluded from MCP tools/list + REST discovery (diagnostics like echo)
  handler: (ctx: OperationContext, params: any) => Promise<unknown>;
}

/** Capture the params schema type P at the definition site so `handler(params)` is z.infer<P>. */
export function defineOp<P extends z.ZodObject<z.ZodRawShape>>(op: {
  name: string;
  description: string;
  params: P;
  requiredRole?: Role;
  mutating?: boolean;
  hidden?: boolean;
  handler: (ctx: OperationContext, params: z.infer<P>) => Promise<unknown>;
}): Operation {
  return op as unknown as Operation;
}

// ── The M1 operations ─────────────────────────────────────────────────────

const whoami = defineOp({
  name: 'whoami',
  description: 'Return the calling identity: principal id, active workspace, role, grants, transport.',
  params: z.object({}),
  handler: async (ctx) => ({
    principal: ctx.principal,
    workspaceId: ctx.workspaceId,
    role: ctx.role,
    grants: ctx.grants,
    remote: ctx.remote,
  }),
});

const echo = defineOp({
  name: 'echo',
  description: 'Connectivity/validation diagnostic: echoes the given message. Internal; not an agent tool.',
  params: z.object({ message: z.string() }),
  hidden: true,
  handler: async (_ctx, params) => ({ message: params.message }),
});

const get_workspace = defineOp({
  name: 'get_workspace',
  description: 'Return the current workspace (id and name).',
  params: z.object({}),
  handler: async (ctx) => {
    // No workspace_id predicate — RLS (workspaces_current) is the SOLE scoper (review AM12).
    const rows = await withScopedTx(ctx, (tx) => tx<{ id: string; name: string }[]>`
      select id, name from workspaces`);
    const row = rows[0];
    if (!row) throw new OperationError('not_found', 'workspace not found');
    return row;
  },
});

const list_members = defineOp({
  name: 'list_members',
  description: 'List members of the current workspace (principal id, role, joined). Admin only.',
  params: z.object({}),
  requiredRole: 'admin',
  handler: async (ctx) =>
    // No workspace_id predicate — RLS (workspace_members_ws) is the SOLE scoper (review AM12).
    withScopedTx(ctx, (tx) => tx`
      select principal_id, role, created_at from workspace_members order by created_at`),
});

// ── Registry + integrity guards (AM2/AM5) ─────────────────────────────────

export const operations: Operation[] = [whoami, echo, get_workspace, list_members];

// Null-prototype map: a request for an op named after an Object.prototype member (toString,
// constructor, __proto__, hasOwnProperty, …) must resolve to `undefined` (→ unknown_op), NOT an
// inherited function. A plain {} would return that function — truthy — skipping the miss-guard in
// dispatch and crashing on op.params. Object.create(null) has no prototype, so every miss is undefined.
const byName: Record<string, Operation> = Object.create(null);
for (const op of operations) {
  if (!(op.params instanceof z.ZodObject)) {
    throw new Error(`operation "${op.name}": params must be a z.object`);
  }
  if (byName[op.name]) throw new Error(`duplicate operation name: ${op.name}`);
  byName[op.name] = op;
}

export const operationsByName: Record<string, Operation> = byName;
