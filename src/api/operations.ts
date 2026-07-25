// Ops-as-data registry. The single source every transport (REST /api/:op, stdio MCP) generates from.
// Registry/dispatch pattern ported from gbrain's src/core/operations.ts under MIT — see NOTICE.
// Adapted: params are zod schemas (D21) instead of gbrain's ParamDef; the context is company-brain's
// tenant identity (src/core/context.ts); handlers open their own withScopedTx for DB work (D6).
import { z } from 'zod';
import type { OperationContext } from '../core/context.ts';
import type { Role } from './roles.ts';
import { withScopedTx } from '../db/client.ts';
import { OperationError } from './errors.ts';
import { importPage } from '../ingest/import.ts';
import { answerQuestion } from '../answer/answer.ts';
import { createInvite } from '../auth/invites.ts';

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

// ── A17 answer-quality spike: ingest + ask ────────────────────────────────
// M3's first real draft (see docs/plan.md's M3 file layout + DECISIONS D31), not throwaway —
// src/ingest/import.ts and src/search+answer/ get hardened (content-sanity, dedup, leak-canary,
// reranker activation) later; the core loop proved here carries forward unchanged.

const ingest = defineOp({
  name: 'ingest',
  description: 'Ingest a page: chunk the body, embed each chunk, and write page + chunks atomically.',
  params: z.object({
    slug: z.string(),
    title: z.string(),
    body: z.string(),
    tags: z.array(z.string()).optional(),
    scope: z.string().optional(),
  }),
  requiredRole: 'member',
  mutating: true,
  handler: async (ctx, params) => importPage(ctx, params),
});

const ask = defineOp({
  name: 'ask',
  description: 'Answer a question by retrieving relevant chunks (hybrid search + RRF) and generating a cited answer.',
  params: z.object({ question: z.string() }),
  requiredRole: 'member',
  handler: async (ctx, params) => answerQuestion(ctx, params.question),
});

// ── Invites (M2, G6) ──────────────────────────────────────────────────────

const create_invite = defineOp({
  name: 'create_invite',
  description:
    'Invite someone to the current workspace by email. Returns a single-use accept URL — the token ' +
    'is shown ONCE and stored only as a hash, so it cannot be read back. M2 sends no email; copy the URL.',
  params: z.object({
    email: z.string().min(3).max(320),
    role: z.string().default('member'),
  }),
  requiredRole: 'admin',
  mutating: true,
  // Runs inside withScopedTx on the cb_app lane, so the invites_ws policy's
  // WITH CHECK (workspace_id = app.workspace) structurally confines the row to one tenant.
  //
  // The role ceiling inside createInvite is an APP-LAYER control — cb_app holds table-level INSERT
  // on invites, so nothing in the database stops an invites.role='owner' write. For most of M2 this
  // op was not registered at all, which meant that ceiling had never once executed; it now has a
  // test (test/invites.test.ts) precisely because the database will not catch a regression here.
  handler: async (ctx, params) => withScopedTx(ctx, (tx) => createInvite(tx, ctx, params)),
});

// ── Registry + integrity guards (AM2/AM5) ─────────────────────────────────

export const operations: Operation[] = [whoami, echo, get_workspace, list_members, ingest, ask, create_invite];

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
