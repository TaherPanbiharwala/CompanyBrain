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
import {
  listPages,
  deletePage,
  deletePages,
  rescopePages,
  replacePage,
  getPage,
  MAX_BATCH_PAGES,
} from '../ingest/lifecycle.ts';
import { hybridSearch } from '../search/hybrid.ts';
import { importFile, MAX_FILE_BYTES } from '../ingest/file.ts';
import { PACK, PACK_KINDS, DEFAULT_PACK_KIND } from '../core/pack.ts';
import { answerQuestion } from '../answer/answer.ts';
import { createInvite } from '../auth/invites.ts';
import { PAGE_SCOPES, DEFAULT_PAGE_SCOPE } from '../core/context.ts';
/** Longest pasted body an `ingest`/`replace_page` call may carry, in CHARACTERS.
 *
 *  Published verbatim in /api/_ops and MCP tools/list, so it is a PROMISE to callers — which is why
 *  src/api/server.ts sizes those routes' transport limit from it rather than guessing. Worst-case
 *  UTF-8 is 4 bytes per character, so 200k characters can be 800KB on the wire; the app-wide 100kb
 *  cap made this schema unsatisfiable by 2x-8x until M5 Phase 1. test/body-limits.test.ts pins the
 *  two together. */
export const MAX_BODY_CHARS = 200_000;

/** The slug rule, EXPORTED rather than left inline in the zod literal below.
 *
 *  Same reasoning as GRANT_TAG_RE (src/core/context.ts): a rule with more than one consumer is held
 *  together by a test or not at all. src/eval/slug.ts generates slugs for eval corpora and must
 *  satisfy exactly this gate, but it is a pure module that cannot import this one without dragging
 *  the whole op/dispatch chain into a test that is supposed to need no database. So it keeps its own
 *  copy and test/eval-harness.test.ts pins the two against each other. */
export const SLUG_MAX_LEN = 200;
export const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;


/** A registered operation (type-erased so a heterogeneous registry stays homogeneous). Define via
 *  defineOp so per-op params stay type-safe at the definition site. */
export interface Operation {
  name: string;
  description: string;
  params: z.ZodObject<z.ZodRawShape>; // z.object → keyed redaction (.shape) + MCP inputSchema (AM2)
  requiredRole?: Role; // default 'member'
  mutating?: boolean; // read vs write (log + future routing)
  hidden?: boolean; // excluded from MCP tools/list + REST discovery (diagnostics like echo)
  /** JSON-Schema keys merged over the generated inputSchema, for constraints zod cannot express on a
   *  ZodObject. `.refine()` returns a ZodEffects, which has no `.strict()` or `.shape` — both of
   *  which dispatch and redaction require — so a mutually-exclusive param set is enforced in the
   *  handler and DECLARED here. Without it the published schema is looser than the handler, and an
   *  agent plans against the loose one. See buildToolDefs. */
  jsonSchemaExtra?: Record<string, unknown>;
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
  jsonSchemaExtra?: Record<string, unknown>;
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
  description:
    'Ingest a page: chunk the body, embed each chunk, and write page + chunks atomically. ' +
    "Writes to shared workspace memory by default; pass scope:'private' to restrict it to yourself. " +
    'Use replace_page to change the text afterwards, rescope_pages to change who can see it, and ' +
    'delete_page to remove it.',
  // Every bound here turns a 500 into a diagnosable 400. Unbounded `z.string()` meant an over-long
  // slug raised Postgres 54000 ("index row size exceeds btree maximum") from the UNIQUE index, and a
  // huge body drove an unbounded number of paid embedding calls — both surfacing as a generic
  // `internal_error`. On the MCP and CLI transports there is no express body cap at all, so nothing
  // bounded any of this even incidentally.
  params: z.object({
    // Lowercase kebab-ish. It is a URL-facing identifier and a UNIQUE btree key, so both the charset
    // and the length matter; 200 is far under the ~2704-byte index-row limit.
    slug: z.string().min(1).max(SLUG_MAX_LEN).regex(SLUG_RE, 'slug must be lowercase alphanumeric with . _ or -'),
    title: z.string().min(1).max(300),
    body: z.string().min(1).max(MAX_BODY_CHARS),
    tags: z.array(z.string().min(1).max(64)).max(50).optional(),
    // An enum at the OP boundary, deliberately, while the column stays TEXT with no CHECK. Migration
    // 0004 recorded that on purpose — the list is a convention so a new type needs no migration — so
    // validating here reports a bad value to the caller as a 400, where a database constraint would
    // turn the same mistake into a 500.
    kind: z
      .enum(PACK_KINDS)
      .default(DEFAULT_PACK_KIND)
      .describe(
        `What this page is about, which shapes what gets extracted from it later. ${PACK.map((p) => `${p.kind}: ${p.description}`).join(' ')}`,
      ),
    // An ENUM, not z.string(). This is an access-control knob: it decides whether the row's acl is
    // `self:<author>` or `ws:<workspace>`, and the database enforces the acl. Publishing it as an
    // open string let any value persist into a column M4 branches on, and told agents reading
    // /api/_ops that anything goes. The CHECK in migration 0003 is the matching DB-side guard.
    //
    // .default() rather than .optional(): the default is the MORE EXPOSING value, and an optional
    // field with no stated default reads to an agent as "omit it and nothing happens". zodToJsonSchema
    // emits `"default": "workspace"` only for .default(), and /api/_ops is deliberately unauthenticated
    // (D53) — so this is the one place an agent can learn what omitting the field actually means.
    // .describe() lands in the published schema for the same reason.
    scope: z
      .enum(PAGE_SCOPES)
      .default(DEFAULT_PAGE_SCOPE)
      .describe(
        "Who can read this page. 'workspace' (used when omitted): every member of the current " +
          "workspace. 'private': only the calling principal — enforced by the database, not " +
          'advisory. replace_page keeps whatever scope the page already has; rescope_pages is the op ' +
          'that changes it afterwards.',
      ),
  }),
  requiredRole: 'member',
  mutating: true,
  handler: async (ctx, params) => importPage(ctx, params),
});

const ask = defineOp({
  name: 'ask',
  description:
    'Answer a question by retrieving relevant chunks (hybrid search + RRF) and generating a cited ' +
    'answer. Retrieval is permission-filtered: it searches only the pages your grants allow you to ' +
    'read, so "not found" can also mean "not visible to you." The response carries ' +
    '`degraded: "keyword_only"` when the embedding provider was unavailable and only keyword ' +
    'matching ran — treat a thin answer as incomplete rather than as an empty corpus.',
  // Bounded: `question` reaches embed() AND the chat prompt, both paid calls. Unbounded, a 100kb
  // question exceeded the embedding input limit and surfaced as `internal_error` — a 500 for what is
  // plainly an input-validation failure, after the money was already spent.
  params: z.object({ question: z.string().min(1).max(2_000) }),
  requiredRole: 'member',
  handler: async (ctx, params) => answerQuestion(ctx, params.question),
});

// ── Lifecycle (M3) ────────────────────────────────────────────────────────
// These make ingest reversible. `ingest`'s own description (above) points at replace_page,
// delete_page and rescope_pages.
//
// D68 closed the re-scope path deliberately, and rescope_pages reopens it under a NARROWER rule than
// D68 refused: scope still cannot be passed as an acl (aclForScope remains the only stamper), and
// making a page private is restricted to its author — because aclForScope derives the private grant
// from the CALLER, so an admin doing it would stamp their own grant on someone else's page and lock
// the author out. 0007's WITH CHECK would refuse it anyway; the app refuses first, with a message.

// The two destructive ops share this addressing. pageId is unambiguous; slug is a convenience that
// can legitimately match two rows since migration 0007 (a shared page and your private page may
// carry the same slug), so lifecycle.ts refuses rather than guessing. The XOR is enforced in the
// handler by requireOneRef, NOT by .refine(): the registry calls .strict() on every params object,
// and a refinement would turn it into a ZodEffects that has no .strict().
const PAGE_REF = {
  pageId: z.string().uuid().optional().describe('The page id from list_pages. Unambiguous; prefer this.'),
  slug: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('The page slug. Rejected if it matches more than one page you can see — pass pageId instead.'),
};

const list_pages = defineOp({
  name: 'list_pages',
  description:
    'List the pages you can read in this workspace, newest-updated first, with their chunk counts. ' +
    'Permission-filtered: a colleague\'s private page is absent here for the same reason it is absent ' +
    'from search. This is how you find a pageId for delete_page or replace_page. ' +
    'PAGINATED: returns at most `limit` pages and sets `hasMore: true` when more remain — raise ' +
    '`offset` to continue. There is no total count, so an empty result means "no more from here", ' +
    'not "the workspace is empty".',
  params: z.object({
    limit: z.number().int().min(1).max(200).describe('Maximum pages to return. Default 50.').default(50),
    offset: z
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .describe('How many pages to skip. Combine with `hasMore` in the response to walk the list.')
      .default(0),
  }),
  requiredRole: 'member',
  handler: async (ctx, params) => listPages(ctx, params),
});

const get_page = defineOp({
  name: 'get_page',
  description:
    'Fetch one page by id or slug, including its full text. list_pages returns metadata only and ' +
    'search returns matching fragments, so this is the way to read a document back in full. ' +
    'Pass exactly one of pageId or slug.',
  params: z.object(PAGE_REF),
  requiredRole: 'member',
  mutating: false,
  handler: async (ctx, params) => getPage(ctx, params),
});

// One destructive page op, three arms — NOT a second `delete_pages` op sitting one character away
// from this one in the same tools/list. Two near-identical names, both mutating and both
// irreversible, is a footgun for exactly the caller least able to recover from it.
const delete_page = defineOp({
  name: 'delete_page',
  description:
    'Delete a page and everything derived from it: its chunks, and the original uploaded file if it ' +
    'came from one. Irreversible, with no undo and no trash. You may delete pages you authored; ' +
    'admins may delete any page they can read. Pass exactly one of pageId, slug, or pageIds. ' +
    'With pageId or slug it returns {pageId, slug, sourceRemoved}. With pageIds it deletes up to ' +
    String(MAX_BATCH_PAGES) + ' at once and returns {deleted, sourcesRemoved, outcomes} instead — ' +
    'a per-page outcome list where each entry carries a machine-readable `code` (ok, not_visible, ' +
    'not_author, refused) plus prose, so pages you cannot delete are reported and the rest still go.',
  // NO .refine() here. The registry's type is ZodObject and .refine() returns ZodEffects, which does
  // not satisfy it — the same trap docs/enabling-team-scope.md's preface records as breaking module
  // load. The XOR is enforced in the handler, which is where requireOneRef already enforces the
  // pageId/slug half of it.
  params: z.object({
    ...PAGE_REF,
    pageIds: z
      .array(z.string().uuid())
      .min(1)
      .max(MAX_BATCH_PAGES)
      .optional()
      .describe('Delete many at once. Pass this INSTEAD of pageId or slug, never alongside them.'),
  }),
  requiredRole: 'member',
  mutating: true,
  // The XOR the handler enforces, stated in the published schema so an agent does not have to
  // discover it by receiving a 400. oneOf's branches each require exactly one addressing field and
  // forbid the other two, which is precisely what requireOneRef and the guard below implement.
  jsonSchemaExtra: {
    oneOf: [
      { required: ['pageId'], not: { anyOf: [{ required: ['slug'] }, { required: ['pageIds'] }] } },
      { required: ['slug'], not: { anyOf: [{ required: ['pageId'] }, { required: ['pageIds'] }] } },
      { required: ['pageIds'], not: { anyOf: [{ required: ['pageId'] }, { required: ['slug'] }] } },
    ],
  },
  handler: async (ctx, params) => {
    if (!params.pageIds) return deletePage(ctx, params);
    if (params.pageId || params.slug) {
      throw new OperationError(
        'invalid_params',
        'pass pageIds on its own, not alongside pageId or slug',
        'Use pageIds for a batch, or pageId/slug for exactly one page.',
      );
    }
    return deletePages(ctx, params.pageIds);
  },
});

const rescope_pages = defineOp({
  name: 'rescope_pages',
  description:
    'Move pages between private and workspace scope. This is the only way to change a page\'s ' +
    'visibility after ingest — scope is otherwise fixed forever. Cheap: no re-chunking and no ' +
    're-embedding, because permissions are derived from scope rather than stored separately. ' +
    'You may re-scope pages you authored; admins may re-scope any page they can read, EXCEPT that ' +
    'making a page private is restricted to its author (an admin doing it would lock the author out ' +
    'of their own page). Up to ' + String(MAX_BATCH_PAGES) + ' at once, returning a per-page outcome ' +
    'list: every entry carries a machine-readable `code` (ok, not_visible, not_author, ' +
    'already_at_scope, slug_taken) plus prose. Pages already at the target scope report ok:true — ' +
    'the call is idempotent. Nothing that is skipped stops the rest.',
  params: z.object({
    pageIds: z.array(z.string().uuid()).min(1).max(MAX_BATCH_PAGES),
    scope: z.enum(PAGE_SCOPES),
  }),
  requiredRole: 'member',
  mutating: true,
  handler: async (ctx, params) => rescopePages(ctx, params.pageIds, params.scope),
});

const replace_page = defineOp({
  name: 'replace_page',
  description:
    'Replace a page\'s text, re-chunking and re-embedding it. Keeps the page id, slug, scope and ' +
    'permissions; updates its modified time. Refused for pages created from an uploaded file — ' +
    'delete and re-ingest those, so the stored file and the indexed text keep describing the same document.',
  params: z.object({
    ...PAGE_REF,
    // Same bound as `ingest`.body, for the same reason: this text reaches a paid embedding call.
    body: z.string().min(1).max(MAX_BODY_CHARS),
    title: z.string().min(1).max(300).optional().describe('Leave unset to keep the current title.'),
    tags: z.array(z.string().min(1).max(64)).max(50).optional().describe('Leave unset to keep the current tags.'),
  }),
  requiredRole: 'member',
  mutating: true,
  handler: async (ctx, params) => replacePage(ctx, params),
});

// ── File ingest (M3) ──────────────────────────────────────────────────────
//
// TAKES BYTES, NEVER A PATH, and this is a security boundary rather than an interface preference.
// /api/_ops is unauthenticated (D53) and every op below `admin` is callable by any `member` — a role
// domain auto-join hands to any Workspace account on a claimed domain. An op accepting
// `{"path": "..."}` would let a caller name `/proc/self/environ` and have the server ingest
// OPENAI_API_KEY, DATABASE_URL, CB_APP_DB_PASSWORD and SESSION_SECRET into a page, which `ask` would
// then read back out on request. `bun run ingest-file` reads the file LOCALLY and sends the bytes.
const ingest_file = defineOp({
  name: 'ingest_file',
  description:
    'Ingest a document from its bytes: PDF, Word (.docx), Excel (.xlsx), CSV, JSON, HTML or plain ' +
    'text. The format is detected from the CONTENT, not the filename. Chunks carry the page or cell ' +
    'range they came from, so answers can cite a position, and the original file is retained so that ' +
    'citation can be opened. Send base64 — there is deliberately no way to name a server-side path. ' +
    `The decoded file must be at most ${MAX_FILE_BYTES / 1_048_576} MB.`,
  params: z.object({
    filename: z
      .string()
      .min(1)
      .max(255)
      .describe('The name as uploaded. Display only — the format is detected from the bytes.'),
    // DERIVED from the enforced limit, not hand-written beside it. A literal 8_000_000 advertised a
    // bound ~35% larger than importFile actually accepts, so /api/_ops and the MCP tool list — the
    // only contract an agent has — overstated what would succeed. base64 is 4 chars per 3 bytes,
    // plus a little slack for padding and whitespace.
    content_base64: z
      .string()
      .min(1)
      .max(Math.ceil((MAX_FILE_BYTES * 4) / 3) + 1024)
      .describe(`Base64-encoded file bytes. The DECODED file must be at most ${MAX_FILE_BYTES / 1_048_576} MB.`),
    slug: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[a-z0-9][a-z0-9._-]*$/, 'slug must be lowercase alphanumeric with . _ or -'),
    title: z.string().min(1).max(300).optional().describe("Defaults to the document's own title, then the filename."),
    tags: z.array(z.string().min(1).max(64)).max(50).optional(),
    kind: z.enum(PACK_KINDS).default(DEFAULT_PACK_KIND),
    scope: z
      .enum(PAGE_SCOPES)
      .default(DEFAULT_PAGE_SCOPE)
      .describe(
        "Who can read this file and everything derived from it. 'workspace' (used when omitted): " +
          "every member. 'private': only you — enforced by the database, and it covers the stored " +
          'original bytes too, not just the text.',
      ),
  }),
  requiredRole: 'member',
  mutating: true,
  handler: async (ctx, params) => {
    let bytes: Uint8Array;
    try {
      // Buffer.from is lenient — it ignores characters outside the base64 alphabet rather than
      // throwing — so a truncated or corrupted upload decodes to SHORTER bytes instead of failing.
      // That is caught downstream by magic-byte detection (a half PDF is not a PDF) rather than
      // pretended about here.
      bytes = new Uint8Array(Buffer.from(params.content_base64, 'base64'));
    } catch {
      throw new OperationError('invalid_params', 'content_base64 is not valid base64');
    }
    if (bytes.byteLength === 0) {
      throw new OperationError('invalid_params', 'content_base64 decoded to zero bytes');
    }
    return importFile(ctx, {
      bytes,
      filename: params.filename,
      slug: params.slug,
      title: params.title,
      tags: params.tags,
      kind: params.kind,
      scope: params.scope,
    });
  },
});

// ── Search (M3) ───────────────────────────────────────────────────────────
//
// LANDS LAST, and the ordering was a real constraint rather than tidiness: this op's contract is
// made of things that did not exist until the rest of M3 shipped. `score` was discarded by
// hybridSearch entirely, `locator` had no column, and `degraded` had no way to be expressed. Both
// /api/_ops and the MCP tool list publish this schema as stable, so shipping it early would have
// meant publishing a contract and then breaking it.
const search = defineOp({
  name: 'search',
  description:
    'Retrieve the passages most relevant to a query, ranked, with the page and position each came ' +
    'from. No model call and no generated prose — this is the retrieval step of `ask` on its own, ' +
    'for when you want the evidence rather than an answer. Permission-filtered like everything else: ' +
    '"nothing found" can also mean "nothing you can read". The response carries ' +
    '`degraded: "keyword_only"` when the embedding provider was unavailable and only keyword ' +
    'matching ran — treat a thin result set as incomplete rather than as an empty corpus.',
  params: z.object({
    query: z.string().min(1).max(2_000),
    // Bounded well below the arm limits: asking for more than retrieval fetches would return a
    // short list and look like a corpus problem.
    limit: z.number().int().min(1).max(20).default(8),
  }),
  requiredRole: 'member',
  handler: async (ctx, params) => {
    const { hits, degraded } = await hybridSearch(ctx, params.query, { topK: params.limit });
    return {
      // `degraded` is surfaced here for the same reason `ask` carries it: a short result list and a
      // short result list from half a search look identical, and dispatchOp reads this field to log
      // `ok_degraded`.
      degraded,
      results: hits.map((h) => ({
        pageId: h.pageId,
        slug: h.slug,
        title: h.title,
        chunkId: h.chunkId,
        ord: h.ord,
        content: h.content,
        // Both forms: the structured locator for a caller that wants to open the file at the right
        // place, and the rendered one so a human-facing citation does not have to re-implement
        // formatLocator. Null for pasted text, which has no position inside a source document.
        locator: h.locator,
        citation: h.citation,
        // The owning page's visibility label, so a caller can show WHO ELSE can see a source it
        // just cited. A label, never the control — `acl` is what RLS enforces, and this row only
        // exists because the acl already matched the caller's keyring.
        scope: h.scope,
        score: h.score,
      })),
    };
  },
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

const declared: Operation[] = [
  whoami,
  echo,
  get_workspace,
  list_members,
  ingest,
  ask,
  list_pages,
  delete_page,
  rescope_pages,
  replace_page,
  ingest_file,
  get_page,
  search,
  create_invite,
];

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
