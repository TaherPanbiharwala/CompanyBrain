// The "who is asking" object threaded through every operation.
//
// Two invariants the whole product rests on (DECISIONS D2):
//   * FAIL CLOSED. buildContext throws if workspaceId / principal / grants can't be resolved,
//     or if principal/workspaceId aren't valid UUIDs (a malformed value would otherwise make the
//     RLS `::uuid` cast abort the whole transaction). No `{}`/unfiltered fallback, no
//     `remote === false` scope-widening.
//   * grants is the keyring: self + workspace now; team:/role: unioned in at M5. A row is
//     visible iff `acl && grants` (array overlap), enforced in engine queries (M3) and RLS (M4).

export type Grant = string; // e.g. 'self:<uuid>', 'ws:<uuid>', 'team:<uuid>', 'role:admin'

// Grants are serialized into the app.grants GUC (a CSV) that the M4 RLS policy splits with
// string_to_array. One definition, shared by withScopedTx and (later) the SQL side.
export const GRANT_SEPARATOR = ',';
// Strict shape: a known prefix + a safe id. Excludes the separator and empty/whitespace tags,
// so nothing can smuggle an extra grant through the CSV (review sec S11).
/** EXPORTED so the rule can be pinned against its two SQL copies — acl_grants_tag_ck in migration
 *  0007 and doctor's acl-tag census — by test/acl-tag-format.test.ts. There is no way to import a
 *  TypeScript constant into SQL, so the three copies are held together by a test or not at all. */
export const GRANT_TAG_RE = /^(self|ws|team|role):[A-Za-z0-9_-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function serializeGrants(grants: readonly Grant[]): string {
  return grants.join(GRANT_SEPARATOR);
}

export interface OperationContext {
  readonly principal: string;   // principal id (uuid)
  readonly workspaceId: string; // workspace id (uuid) — the tenant
  readonly grants: readonly Grant[]; // non-empty keyring
  readonly role: string;        // RBAC role in this workspace (owner|admin|member)
  readonly actingAgent?: string; // set when an agent acts on a principal's behalf
  readonly remote: boolean;     // true = untrusted agent/MCP caller. NOT a scope switch.
}

export interface ContextInput {
  principal?: string | null;
  workspaceId?: string | null;
  grants?: readonly Grant[] | null;
  role?: string | null;
  actingAgent?: string;
  remote: boolean;
}

// Auth error taxonomy (matches the M1 OperationError codes; review A16).
export type ContextErrorCode =
  | 'unauthenticated'
  | 'no_workspace'
  | 'no_grant'
  | 'bad_principal'
  | 'bad_workspace'
  | 'bad_grant';

export class ContextError extends Error {
  readonly code: ContextErrorCode;
  constructor(code: ContextErrorCode, message: string) {
    super(message);
    this.name = 'ContextError';
    this.code = code;
  }
}

// Tags are LOWERCASED, and that is a correctness requirement rather than tidiness.
//
// Grant matching is `acl && grants` — Postgres array overlap, which is byte equality. UUID_RE below
// carries the /i flag, and `bun run call` / the MCP bridge take the principal verbatim from
// CB_CLI_PRINCIPAL / CB_MCP_PRINCIPAL, so an operator pasting an uppercase UUID stamps
// `self:A1B2…` on their page. The read path gets its ids from cb_internal.resolve_session, which
// returns a `uuid` that postgres.js renders canonically lowercase — `self:a1b2…`. Those two strings
// do not overlap, so the author's own private page becomes permanently unreadable by anyone.
// Invisible today (nothing compares acl to grants); permanent the moment the M3 policy lands.
export const selfGrant = (principal: string): Grant => `self:${principal.toLowerCase()}`;
export const wsGrant = (workspaceId: string): Grant => `ws:${workspaceId.toLowerCase()}`;

/** Build the request keyring: self + workspace, plus any team/role grants (M5). */
export function resolveGrants(principal: string, workspaceId: string, extra: readonly Grant[] = []): Grant[] {
  return [selfGrant(principal), wsGrant(workspaceId), ...extra];
}

// ── Row visibility: scope → acl ───────────────────────────────────────────
// A row is visible iff `acl && grants`. Since every caller's keyring is
// [self:<them>, ws:<their workspace>], a row tagged `self:<author>` is readable by that author
// alone, and a row tagged `ws:<workspace>` by every member. That is the whole mechanism.
//
// This lives here, beside the grant constructors, because `scope` is not free-form metadata — it
// NAMES a visibility policy, and the acl is what the database will actually enforce. Until the M1+M2
// review those two had drifted apart: `scope` was `z.string()` with no CHECK, and `importPage`
// stamped `ws:` unconditionally, so `scope:'private'` produced a row every member could read. The
// label was decorative. That mattered beyond cosmetics because at M4 the enforced predicate becomes
// `acl && current_grants()` — the database reads the ACL, never the label — so any row written with
// a mismatched pair would have been permanently mis-scoped with no way to recover the author's
// intent. Deriving one from the other makes the mismatch unrepresentable.

export const PAGE_SCOPES = ['private', 'workspace'] as const;
export type PageScope = (typeof PAGE_SCOPES)[number];

/** Default when a caller does not say. Workspace-wide: a company brain nobody else can read is not
 *  a company brain, and D0.1 settled on workspace-default with a private option that works. */
export const DEFAULT_PAGE_SCOPE: PageScope = 'workspace';

export function isPageScope(x: string): x is PageScope {
  return (PAGE_SCOPES as readonly string[]).includes(x);
}

/** The acl a row with this scope must carry. The ONLY place the mapping exists. */
export function aclForScope(scope: PageScope, ctx: Pick<OperationContext, 'principal' | 'workspaceId'>): Grant[] {
  return scope === 'private' ? [selfGrant(ctx.principal)] : [wsGrant(ctx.workspaceId)];
}

/** The only constructor for an OperationContext. Fail-closed. */
export function buildContext(input: ContextInput): OperationContext {
  if (!input.principal) {
    throw new ContextError('unauthenticated', 'no principal on the request');
  }
  if (!UUID_RE.test(input.principal)) {
    throw new ContextError('bad_principal', 'principal is not a valid uuid');
  }
  if (!input.workspaceId) {
    throw new ContextError('no_workspace', 'no workspace resolved for the request');
  }
  if (!UUID_RE.test(input.workspaceId)) {
    throw new ContextError('bad_workspace', 'workspaceId is not a valid uuid');
  }
  if (!input.grants || input.grants.length === 0) {
    throw new ContextError('no_grant', 'empty grants keyring; refusing to run unscoped');
  }
  for (const g of input.grants) {
    if (!GRANT_TAG_RE.test(g)) {
      throw new ContextError('bad_grant', `invalid grant tag: ${JSON.stringify(g)}`);
    }
  }
  return {
    principal: input.principal,
    workspaceId: input.workspaceId,
    grants: [...input.grants],
    role: input.role ?? 'member',
    actingAgent: input.actingAgent,
    remote: input.remote,
  };
}

/**
 * App-layer visibility check (array overlap): does this row's `acl` intersect the caller's grants?
 *
 * NOT CALLED BY ANYTHING YET, and the DB does NOT enforce the same thing — the docstring used to say
 * it did. No policy in schema.sql or any migration references `acl` or `app.grants`; the content
 * plane is workspace-equality only (`pages_ws`, `content_chunks_ws`). `acl && current_grants()`
 * becomes the enforced predicate at M3/M4, and this is the reference implementation of the semantics
 * the SQL will have to match — which is why it is kept and tested (test/context.test.ts) rather than
 * deleted. Until then it describes an intent, not a control.
 */
export function visibleBy(acl: readonly string[], grants: readonly Grant[]): boolean {
  return acl.some((a) => grants.includes(a));
}
