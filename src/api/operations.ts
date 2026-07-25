// Ops-as-data registry. The single source every transport (REST /api/:op, stdio MCP) generates from.
// Registry/dispatch pattern ported from gbrain's src/core/operations.ts under MIT — see NOTICE.
// Adapted: params are zod schemas (D21) instead of gbrain's ParamDef; the context is company-brain's
// tenant identity (src/core/context.ts); handlers open their own withScopedTx for DB work (D6).
import { z } from 'zod';
import type { OperationContext } from '../core/context.ts';
import { ROLES_TUPLE, type Role } from './roles.ts';
import { withScopedTx } from '../db/client.ts';
import { OperationError } from './errors.ts';
import { importPage } from '../ingest/import.ts';
import { answerQuestion } from '../answer/answer.ts';
import { createInvite } from '../auth/invites.ts';
import { PAGE_SCOPES } from '../core/context.ts';

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
  // Every bound here turns a 500 into a diagnosable 400. Unbounded `z.string()` meant an over-long
  // slug raised Postgres 54000 ("index row size exceeds btree maximum") from the UNIQUE index, and a
  // huge body drove an unbounded number of paid embedding calls — both surfacing as a generic
  // `internal_error`. On the MCP and CLI transports there is no express body cap at all, so nothing
  // bounded any of this even incidentally.
  params: z.object({
    // Lowercase kebab-ish. It is a URL-facing identifier and a UNIQUE btree key, so both the charset
    // and the length matter; 200 is far under the ~2704-byte index-row limit.
    slug: z.string().min(1).max(200).regex(/^[a-z0-9][a-z0-9._-]*$/, 'slug must be lowercase alphanumeric with . _ or -'),
    title: z.string().min(1).max(300),
    body: z.string().min(1).max(200_000),
    tags: z.array(z.string().min(1).max(64)).max(50).optional(),
    // An ENUM, not z.string(). This is an access-control knob: it decides whether the row's acl is
    // `self:<author>` or `ws:<workspace>`, and the database enforces the acl. Publishing it as an
    // open string let any value persist into a column M4 branches on, and told agents reading
    // /api/_ops that anything goes. The CHECK in migration 0003 is the matching DB-side guard.
    scope: z.enum(PAGE_SCOPES).optional(),
  }),
  requiredRole: 'member',
  mutating: true,
  handler: async (ctx, params) => importPage(ctx, params),
});

const ask = defineOp({
  name: 'ask',
  description: 'Answer a question by retrieving relevant chunks (hybrid search + RRF) and generating a cited answer.',
  // Bounded: `question` reaches embed() AND the chat prompt, both paid calls. Unbounded, a 100kb
  // question exceeded the embedding input limit and surfaced as `internal_error` — a 500 for what is
  // plainly an input-validation failure, after the money was already spent.
  params: z.object({ question: z.string().min(1).max(2_000) }),
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
    // An ENUM so the published inputSchema carries the legal set. As a bare string the MCP
    // tools/list contract said "any string", so an agent would guess 'editor'/'viewer' and get a
    // handler-thrown error instead of a schema-level one naming the options.
    role: z.enum(ROLES_TUPLE).default('member'),
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

const declared: Operation[] = [whoami, echo, get_workspace, list_members, ingest, ask, create_invite];

// ONE registry, and it is strict.
//
// `.strict()` is applied here rather than at each definition site so a future op cannot forget it,
// and it is applied to the EXPORTED array — not only to the by-name map — because the published
// contract and the runtime must come from the same object. `buildToolDefs` emits
// `"additionalProperties": false` into every MCP inputSchema and /api/_ops entry, telling agents an
// undeclared key is invalid, while a plain z.object silently STRIPS unknown keys and returns 200. An
// agent sending `tag` instead of `tags` got a successful ingest with the metadata quietly discarded,
// and the only trace was `unknown_key_count` in a log it cannot read. Publishing from a loose array
// while validating against a strict map would leave exactly that gap one refactor away.
const strict: Operation[] = declared.map((op) => {
  if (!(op.params instanceof z.ZodObject)) {
    throw new Error(`operation "${op.name}": params must be a z.object`);
  }
  return { ...op, params: op.params.strict() };
});

export const operations: Operation[] = strict;

// Null-prototype map: a request for an op named after an Object.prototype member (toString,
// constructor, __proto__, hasOwnProperty, …) must resolve to `undefined` (→ unknown_op), NOT an
// inherited function. A plain {} would return that function — truthy — skipping the miss-guard in
// dispatch and crashing on op.params. Object.create(null) has no prototype, so every miss is undefined.
const byName: Record<string, Operation> = Object.create(null);
for (const op of strict) {
  if (byName[op.name]) throw new Error(`duplicate operation name: ${op.name}`);
  byName[op.name] = op;
}

export const operationsByName: Record<string, Operation> = byName;
