// Page lifecycle: list, delete, replace.
//
// Until now ingest was one-way, which made every corpus reload die on `already_exists` and left no
// way to answer "what is actually in my brain?". These three close that. Re-scoping stays out of
// reach on purpose (D68).
//
// ADDRESSING IS BY PAGE ID, NOT BY SLUG, and that is a consequence of migration 0007 rather than a
// style preference. 0007 replaced UNIQUE(workspace_id, slug) with two PARTIAL unique indexes, so a
// workspace can legitimately hold a shared page `notes` AND your private page `notes` at the same
// time. `where slug = 'notes'` matches both, and a slug-addressed DELETE would then destroy whichever
// one the planner happened to return first. `resolvePage` below accepts a slug for convenience and
// refuses — loudly, naming the candidates — when it is ambiguous.
import { withScopedTx } from '../db/client.ts';
import { withRouterScope } from '../ai/router.ts';
import { toVectorLiteral } from '../ai/vector.ts';
import { chunkText, estimateTokens, CHUNKER_VERSION } from './chunk.ts';
import { embedAll } from './embed.ts';
import { textHash } from './provenance.ts';
import { OperationError } from '../api/errors.ts';
import { aclForScope, type OperationContext, type PageScope } from '../core/context.ts';
import { extractAndReconcileLinks } from '../core/links/reconcile.ts';
import type postgres from 'postgres';

export interface PageSummary {
  id: string;
  slug: string;
  title: string | null;
  kind: string;
  scope: string;
  tags: string[];
  sourceFormat: string | null;
  hasSource: boolean;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ListPagesInput {
  limit?: number;
  offset?: number;
}

/** The raw row shape of the listing query, snake_case as Postgres returns it. */
interface PageRow {
  id: string;
  slug: string;
  title: string | null;
  kind: string;
  scope: string;
  tags: string[];
  source_format: string | null;
  has_source: boolean;
  chunk_count: number;
  created_at: Date;
  updated_at: Date;
}

export async function listPages(
  ctx: OperationContext,
  input: ListPagesInput = {},
): Promise<{ pages: PageSummary[]; hasMore: boolean }> {
  const limit = input.limit ?? 50;
  const offset = input.offset ?? 0;

  // The row type is named rather than inlined so the opener stays `tx<PageRow[]>` on ONE line. A
  // multi-line generic splits `tx<` from its backtick, and test/scoped-tx-guard.test.ts identifies
  // the handle by walking back to the nearest opener — it reported this query as `handle: unknown`,
  // i.e. as an unscoped content read, which is exactly what it is designed to catch.
  const rows = await withScopedTx(ctx, (tx) => tx<PageRow[]>`
    -- No workspace_id predicate: RLS (pages_ws) is the SOLE scoper (review AM12). The acl half of
    -- that policy is why this doubles as the answer to "what can I actually see" — a colleague's
    -- private page is absent here for the same reason it is absent from search.
    --
    -- The chunk count is a correlated subquery rather than a LEFT JOIN + GROUP BY so the page row
    -- survives with count 0 when a page has no chunks. That state is worth SEEING rather than
    -- hiding: it means an ingest wrote the page and then failed before its chunks landed, or every
    -- chunk drifted out of view, and either way the page is unretrievable while looking fine.
    with page as (
      select id, slug, title, kind, scope, tags, source_format, created_at, updated_at
      from pages
      -- id as the tiebreak, not updated_at alone: rows written in the same transaction share a
      -- timestamp to the microsecond, and an unstable sort under LIMIT/OFFSET silently skips and
      -- repeats rows across pages.
      order by updated_at desc, id
      limit ${limit + 1} offset ${offset}
    )
    -- PAGE FIRST, then decorate. The two subqueries below sit in the target list, and Postgres
    -- evaluates the target list BELOW the Sort node — so written inline against the pages table they ran
    -- once per VISIBLE page, not once per RETURNED page. A workspace with 20k pages paid 40k index
    -- probes to hand back 50 rows. Hoisting the ordering and the limit into a CTE bounds them to
    -- limit+1 without changing the result or the count-0 semantics the correlated form was chosen
    -- for (a LEFT JOIN + GROUP BY would drop pages that have no chunks, which is the state most
    -- worth seeing).
    select
      p.id, p.slug, p.title, p.kind, p.scope, p.tags, p.source_format,
      exists (select 1 from page_sources s where s.page_id = p.id) as has_source,
      (select count(*)::int from content_chunks c where c.page_id = p.id) as chunk_count,
      p.created_at, p.updated_at
    from page p
    order by p.updated_at desc, p.id`);

  // limit + 1 rather than a second count(*): one extra row answers "is there more" exactly, where a
  // separate count is both another round trip and a different snapshot.
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return { hasMore, pages: page.map(toSummary) };
}

/** PageRow -> PageSummary. Extracted at M5 Phase 1 when getPage became a second caller: two copies
 *  of a snake_case-to-camelCase mapping drift silently, and the drift shows up as an undefined field
 *  in a UI rather than as a failure anywhere near the code. */
function toSummary(r: PageRow): PageSummary {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    kind: r.kind,
    scope: r.scope,
    tags: r.tags,
    sourceFormat: r.source_format,
    hasSource: r.has_source,
    chunkCount: r.chunk_count,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/** How the destructive ops address a page. Exactly one field, checked by `requireOneRef` — not a
 *  zod refinement, because the registry requires `params` to stay a plain z.object (it calls
 *  `.strict()` on it, and `.refine()` would return a ZodEffects that has no such method). */
export interface PageRef {
  pageId?: string;
  slug?: string;
}

export function requireOneRef(ref: PageRef): void {
  const given = [ref.pageId, ref.slug].filter((v) => v !== undefined && v !== '');
  if (given.length !== 1) {
    throw new OperationError(
      'invalid_params',
      given.length === 0 ? 'pass either pageId or slug' : 'pass either pageId or slug, not both',
      'pageId is unambiguous; a slug can match two pages (see list_pages).',
    );
  }
}

/** Who may destroy or overwrite a page.
 *
 *  AN APP-LAYER CONTROL, and it has to be named as one: `cb_app` holds table-level DELETE and UPDATE
 *  on `pages`, and the RLS policy is `acl && current_grants()` — which every member satisfies for
 *  every workspace-scoped page, because they all hold `ws:<workspace>`. So the database's answer to
 *  "may this member delete a colleague's shared page?" is yes, and nothing below the app layer will
 *  ever say otherwise. This is the same posture as createInvite's role ceiling, which is documented
 *  in operations.ts as needing its own test precisely because the database cannot catch a regression.
 *
 *  The rule: you may destroy what you authored; an admin may destroy anything they can read. Read
 *  access is unchanged and stays entirely with RLS — this narrows WRITE only.
 *
 *  Deliberately NOT the same error as an invisible page. A caller who can see a page is already
 *  entitled to know it exists, so `permission_denied` here reveals nothing that `list_pages` did not
 *  already show them, and telling them "not found" for a page they are looking at would be a lie. */
/** The predicate behind requireWriteAccess, split out so the BATCH paths can partition instead of
 *  throwing. An undo that aborts on the first page a colleague authored is not an undo — the user
 *  wants the 247 they own gone and the 3 they don't reported. */
function canWrite(ctx: OperationContext, page: { owner_principal: string }): boolean {
  return page.owner_principal === ctx.principal || ctx.role === 'admin' || ctx.role === 'owner';
}

function requireWriteAccess(ctx: OperationContext, page: ResolvedPage, verb: string): void {
  if (canWrite(ctx, page)) return;
  throw new OperationError(
    'permission_denied',
    `"${page.slug}" was created by someone else, so you cannot ${verb} it`,
    'Ask its author, or a workspace admin. You can still read it — this limits changes, not access.',
  );
}

/** Resolve `{pageId}` or `{slug}` to one id, inside a caller-supplied scoped tx.
 *
 *  Every miss — no such row, and a row the caller's grants do not reach — returns the SAME
 *  `not_found`. That is deliberate: distinguishing them would turn every lifecycle op into the
 *  existence oracle migration 0007 spent two partial indexes closing. */
interface ResolvedPage {
  id: string;
  slug: string;
  scope: string;
  acl: string[];
  tags: string[];
  owner_principal: string;
}

async function resolvePage(tx: postgres.TransactionSql, ref: PageRef): Promise<ResolvedPage> {
  const rows = ref.pageId
    ? await tx<ResolvedPage[]>`
        select id, slug, scope, acl, tags, owner_principal from pages where id = ${ref.pageId}`
    : await tx<ResolvedPage[]>`
        select id, slug, scope, acl, tags, owner_principal from pages where slug = ${ref.slug ?? ''}`;

  if (rows.length === 0) {
    throw new OperationError(
      'not_found',
      ref.pageId ? `no page with id ${ref.pageId}` : `no page with slug "${ref.slug}"`,
      'Call list_pages to see the pages you can reach. A page you cannot read is reported the same way as one that does not exist.',
    );
  }
  if (rows.length > 1) {
    // Only reachable via slug, and only because 0007 made slugs unique per (workspace, scope) and
    // per (workspace, author, scope) rather than per workspace. Naming the candidates is safe: this
    // list has already been filtered by the policy, so it holds only pages the caller can read.
    const candidates = rows.map((r) => `${r.id} (scope: ${r.scope})`).join(', ');
    throw new OperationError(
      'invalid_params',
      `slug "${ref.slug}" matches ${rows.length} pages you can see: ${candidates}`,
      'Pass pageId instead of slug. A workspace-scoped page and your own private page may share a slug.',
    );
  }
  return rows[0]!;
}

export interface DeletePageResult {
  pageId: string;
  slug: string;
  /** True when this page had a stored source file (D71). Since migration 0014, delete is a SOFT
   *  delete: the file is not actually gone yet, only immediately unreadable through every existing
   *  path (RLS's USING clause hides it — see 0014's header). It is destroyed for real when
   *  scripts/purge-deleted.ts reaps it after the grace window. Named for the eventual outcome, not
   *  the instant one, to keep the field stable across the M6 change. */
  sourceRemoved: boolean;
}

export async function deletePage(ctx: OperationContext, ref: PageRef): Promise<DeletePageResult> {
  requireOneRef(ref);
  return withScopedTx(ctx, async (tx) => {
    const page = await resolvePage(tx, ref);
    requireWriteAccess(ctx, page, 'delete');

    // Checked BEFORE the delete, because after it the row is invisible (see below) and the answer is
    // unknowable through this handle. It is the one destructive side effect the caller may not have
    // in mind: the original uploaded file is stored only here (D71).
    const hadSource =
      (await tx<{ n: number }[]>`select count(*)::int as n from page_sources where page_id = ${page.id}`)[0]!.n > 0;

    // SOFT delete (migration 0014, mechanism in migrate.ts's ensureAuthFunctions): via
    // cb_internal.soft_delete_page, a SECURITY DEFINER function, not a raw UPDATE on this scoped
    // handle. MEASURED, not a style choice: a plain `update pages set deleted_at = now() ...` here
    // 42501'd — PostgreSQL requires an UPDATE's new row to stay visible under the table's
    // SELECT-governing policies (permissive AND restrictive) regardless of what WITH CHECK declares,
    // and no pure-policy shape lets a scoped connection write past that. The function re-derives the
    // SAME workspace+acl authorization RLS would have applied, from the identical tx-local GUCs, then
    // bypasses RLS by running as the owner — see its definition for the full reasoning. It also marks
    // content_chunks in the SAME statement, and because it runs as the owner it reaches every chunk
    // with this page_id even if one had independently drifted out of this caller's RLS-scoped reach
    // (the residual risk an explicit child UPDATE under RLS would have had — D76's shape, closed here
    // rather than merely accepted).
    //
    // A restrictive, FOR SELECT-only policy (pages_hide_deleted, migration 0016) is what makes the
    // row disappear from every READ the instant this commits — no read call site has to remember a
    // deleted_at filter.
    const [result] = await tx<{ soft_delete_page: boolean }[]>`select cb_internal.soft_delete_page(${page.id})`;
    // resolvePage saw it a moment ago inside this same transaction, so `false` here is not "already
    // gone" — it would mean the function and resolvePage's SELECT disagree about the row, which is a
    // bug worth failing on rather than reporting as success.
    if (!result?.soft_delete_page) {
      throw new OperationError('permission_denied', 'the database refused to delete a page you can read');
    }

    return { pageId: page.id, slug: page.slug, sourceRemoved: hadSource };
  });
}

// ── Batch page operations ─────────────────────────────────────────────────
//
// These exist because upload had no undo. Scope is fixed at ingest and there is no re-scope op;
// replace_page REFUSES any page created from a file (see its comment above); and the web app shipped
// with no delete affordance at all, so recovering from a bad upload meant one curl per page. That is
// tolerable for one pasted document and absurd for a folder — which is exactly the shape bulk upload
// would have made routine.
//
// Both partition rather than abort. A batch where 3 of 250 pages belong to a colleague should remove
// the 247 and TELL you about the 3, because the alternative is a user who retries the whole thing.

/** Cap on one batch. Undo is a recovery path, not a bulk-mutation API — unbounded, one call could
 *  take a workspace out in a single statement, and the request body bound would be the only thing
 *  standing in its way. */
export const MAX_BATCH_PAGES = 250;

/** Most content_chunks rows one UPDATE may rewrite.
 *
 *  Sized against DB_STATEMENT_TIMEOUT (15 s, config.ts:32), not against elegance. `content_chunks`
 *  carries a GIN index on `acl`, a GIN FTS index on `content`, and an HNSW index on a 1536-dim
 *  vector, so an acl UPDATE can never be a heap-only tuple update: every row is rewritten into all
 *  three. The HNSW insert alone runs ~1-3 ms, so ~2,000 rows is a few seconds with room for a loaded
 *  database — where an unbounded statement over a full 250-page batch is tens of seconds and aborts
 *  with 57014 mid-way. */
const MAX_CHUNK_ROWS_PER_UPDATE = 2_000;

/** What happened to one page in a batch.
 *
 *  `code` is the machine-readable half and `reason` is the human half — never only prose. Every other
 *  refusal in this API carries an enum (`WireError.code`), and a caller forced to substring-match
 *  "created by someone else" to tell one refusal from another is a caller whose error handling
 *  breaks the first time someone improves the wording. */
export type BatchOutcomeCode =
  | 'ok'
  | 'not_visible' // no such page, or the caller's grants do not reach it — deliberately one code
  | 'not_author' // visible and readable, but the caller may not make this change
  | 'already_at_scope' // idempotent no-op; reported with ok:true
  | 'slug_taken' // the target scope already has this slug
  | 'refused'; // the database declined a write the caller could read — a bug, surfaced not swallowed

export interface BatchPageOutcome {
  pageId: string;
  slug?: string;
  ok: boolean;
  code: BatchOutcomeCode;
  reason?: string;
}

export interface DeletePagesResult {
  deleted: number;
  sourcesRemoved: number;
  outcomes: BatchPageOutcome[];
}

export async function deletePages(ctx: OperationContext, pageIds: string[]): Promise<DeletePagesResult> {
  const ids = [...new Set(pageIds)];
  if (ids.length === 0) {
    throw new OperationError('invalid_params', 'no page ids given', 'Pass at least one pageId.');
  }
  if (ids.length > MAX_BATCH_PAGES) {
    throw new OperationError(
      'invalid_params',
      `${ids.length} pages is more than one call may delete (limit ${MAX_BATCH_PAGES})`,
      `Delete in batches of ${MAX_BATCH_PAGES} or fewer.`,
    );
  }

  return withScopedTx(ctx, async (tx) => {
    // RLS has already filtered this to pages the caller can READ. Anything missing from the result
    // is either nonexistent or invisible, and — exactly as resolvePage argues — those two must stay
    // indistinguishable or the op becomes an existence oracle.
    const rows = await tx<{ id: string; slug: string; owner_principal: string }[]>`
      select id, slug, owner_principal from pages where id = any(${ids}::uuid[])`;

    const byId = new Map(rows.map((r) => [r.id, r]));
    const outcomes: BatchPageOutcome[] = [];
    const deletable: string[] = [];

    for (const id of ids) {
      const row = byId.get(id);
      if (!row) {
        outcomes.push({ pageId: id, ok: false, code: 'not_visible', reason: 'no such page, or you cannot read it' });
      } else if (!canWrite(ctx, row)) {
        outcomes.push({
          pageId: id,
          slug: row.slug,
          ok: false,
          code: 'not_author',
          reason: 'created by someone else — ask its author or a workspace admin',
        });
      } else {
        deletable.push(id);
      }
    }

    if (deletable.length === 0) return { deleted: 0, sourcesRemoved: 0, outcomes };

    // Counted BEFORE the delete: afterwards the rows are gone and the answer is unknowable. The
    // stored original is the last copy (D71), so this number is the one worth showing back.
    const sourcesRemoved = (
      await tx<{ n: number }[]>`
        select count(*)::int as n from page_sources where page_id = any(${deletable}::uuid[])`
    )[0]!.n;

    // SOFT delete (migration 0014), via cb_internal.soft_delete_pages — the batch form of the
    // SECURITY DEFINER function deletePage uses; see its comment above for why a raw UPDATE under
    // RLS on this scoped handle does not work and what the function does instead. It marks
    // content_chunks and page_sources in the same statement, unaffected by chunk-acl drift (it runs
    // as the owner).
    //
    // A count mismatch here is NOT necessarily "the function and SELECT disagree" — it is also the
    // ordinary shape of a benign race: `rows` above was read at the start of this transaction, and
    // under READ COMMITTED a concurrent session can commit a change to one of these ids (a rescope,
    // another delete) before this statement runs, causing the function's own WHERE clause to
    // silently exclude it. PARTITION, not abort: an id the function didn't return is reported
    // `refused` and every other id in the batch still succeeds — the exact contract this function's
    // own comment in migrate.ts promises, and the shape the pre-M6 hard-delete code (a single
    // `delete ... returning`, with a missing id reported as `refused`) already had. A prior version
    // of this code aborted the WHOLE transaction on any mismatch via a bare `throw new Error(...)` —
    // surfacing as an opaque 500 and undoing every successful delete in the batch for one contested
    // row. Restored to partition here.
    const gone = await tx<{ soft_delete_pages: string }[]>`select cb_internal.soft_delete_pages(${deletable}::uuid[])`;
    const goneIds = new Set(gone.map((g) => g.soft_delete_pages));
    for (const id of deletable) {
      const row = byId.get(id)!;
      if (goneIds.has(id)) {
        outcomes.push({ pageId: id, slug: row.slug, ok: true, code: 'ok' });
      } else {
        outcomes.push({
          pageId: id,
          slug: row.slug,
          ok: false,
          code: 'refused',
          reason: 'the database refused a delete you can read',
        });
      }
    }

    return { deleted: goneIds.size, sourcesRemoved, outcomes };
  });
}

export interface RescopePagesResult {
  rescoped: number;
  scope: PageScope;
  outcomes: BatchPageOutcome[];
}

/** Move pages between `private` and `workspace`.
 *
 *  This is the op whose absence made "default a bulk upload to private" a trap rather than a safety
 *  net: land 200 documents privately and, with no way to promote them, you have a company brain
 *  nobody at the company can query — and the only fix was delete-and-re-upload all 200, paying the
 *  extraction and embedding cost a second time. With it, default-private becomes staging: land
 *  private, spot-check, promote.
 *
 *  Cheap by construction — no re-chunking, no re-embedding, no bytes move. `acl` is DERIVED from
 *  scope by aclForScope (the only place that mapping exists), and the chunk copy is denormalized, so
 *  the whole operation is two UPDATEs. */
export async function rescopePages(
  ctx: OperationContext,
  pageIds: string[],
  scope: PageScope,
): Promise<RescopePagesResult> {
  const ids = [...new Set(pageIds)];
  if (ids.length === 0) {
    throw new OperationError('invalid_params', 'no page ids given', 'Pass at least one pageId.');
  }
  if (ids.length > MAX_BATCH_PAGES) {
    throw new OperationError(
      'invalid_params',
      `${ids.length} pages is more than one call may re-scope (limit ${MAX_BATCH_PAGES})`,
      `Re-scope in batches of ${MAX_BATCH_PAGES} or fewer.`,
    );
  }
  const acl = aclForScope(scope, ctx);

  return withScopedTx(ctx, async (tx) => {
    const rows = await tx<{ id: string; slug: string; scope: string; owner_principal: string }[]>`
      select id, slug, scope, owner_principal from pages where id = any(${ids}::uuid[])`;
    const byId = new Map(rows.map((r) => [r.id, r]));

    const outcomes: BatchPageOutcome[] = [];
    const candidates: { id: string; slug: string }[] = [];

    for (const id of ids) {
      const row = byId.get(id);
      if (!row) {
        outcomes.push({ pageId: id, ok: false, code: 'not_visible', reason: 'no such page, or you cannot read it' });
      } else if (!canWrite(ctx, row)) {
        outcomes.push({
          pageId: id,
          slug: row.slug,
          ok: false,
          code: 'not_author',
          reason: 'created by someone else — ask its author or a workspace admin',
        });
      } else if (row.scope === scope) {
        // ok:TRUE. The caller asked for "these pages are workspace-scoped" and they are — reporting
        // an idempotent no-op as a failure makes a second click look like a partial outage.
        outcomes.push({ pageId: id, slug: row.slug, ok: true, code: 'already_at_scope', reason: `already ${scope}` });
      } else if (scope === 'private' && row.owner_principal !== ctx.principal) {
        // An admin CAN reach this page (canWrite allows it) but must not make it private, and the
        // database would refuse anyway: aclForScope derives the private grant from the CALLER
        // (`self:<caller>`, context.ts:108), so this would stamp the admin's own grant onto someone
        // else's page. `owner_principal` would still say the author while `acl` said the admin —
        // and RLS is ACL-based while canWrite is owner-based, so the author would be permanently
        // locked out of their own page with only that admin able to undo it.
        //
        // Stamping `self:<author>` instead is not an option: 0007's WITH CHECK lets a writer stamp
        // only grants it HOLDS, and an admin does not hold another principal's self-grant. The
        // policy is already the right answer; this just refuses in the app with a message instead
        // of at the constraint with a 42501.
        outcomes.push({
          pageId: id,
          slug: row.slug,
          ok: false,
          code: 'not_author',
          reason: 'only its author can make a page private — ask them, or leave it workspace-scoped',
        });
      } else {
        candidates.push({ id: row.id, slug: row.slug });
      }
    }

    // Slug uniqueness is PARTIAL on scope (0007's pages_ws_slug_shared / _private), so moving a page
    // across scopes can collide with a page that was legally allowed to share its slug. Pre-checked
    // rather than caught: a 23505 aborts the whole transaction, which would turn one collision into
    // a total failure for the other 249.
    if (candidates.length > 0) {
      const slugs = candidates.map((c) => c.slug);
      // The owner predicate is not optional, and it must match the INDEX rather than intuition. The
      // two partial unique indexes have different keys (0007_acl_rls.sql:137-138):
      //   pages_ws_slug_shared  (workspace_id, slug)                   WHERE scope = 'workspace'
      //   pages_ws_slug_private (workspace_id, owner_principal, slug)  WHERE scope = 'private'
      // Checking only (scope, slug) therefore asks the wrong question for a private target: it
      // false-POSITIVES on a slug some other member holds privately (a legal move, wrongly refused)
      // and false-NEGATIVES when the mover's own private slug collides — and a false negative is the
      // expensive one, because the 23505 then aborts the whole transaction and fails all 250 as an
      // untyped internal_error, which is the exact outcome this pre-check exists to prevent.
      //
      // Private targets are always self-owned by the time we get here (the not_author branch above
      // refuses the rest), so `ctx.principal` is the right owner to test.
      const taken = await tx<{ slug: string }[]>`
        select slug from pages
         where scope = ${scope}
           and slug = any(${slugs}::text[])
           and id <> all(${candidates.map((c) => c.id)}::uuid[])
           and (${scope}::text = 'workspace' or owner_principal = ${ctx.principal})`;
      const takenSet = new Set(taken.map((t) => t.slug));
      for (let i = candidates.length - 1; i >= 0; i--) {
        if (takenSet.has(candidates[i]!.slug)) {
          outcomes.push({
            pageId: candidates[i]!.id,
            slug: candidates[i]!.slug,
            ok: false,
            code: 'slug_taken',
            reason: `a ${scope} page already uses the slug "${candidates[i]!.slug}"`,
          });
          candidates.splice(i, 1);
        }
      }
    }

    if (candidates.length === 0) return { rescoped: 0, scope, outcomes };
    const moving = candidates.map((c) => c.id);

    // Chunks FIRST. Their acl is a denormalized copy of the page's (schema.sql:236), and the policy's
    // USING clause is evaluated against the row's CURRENT acl — which the caller still holds. Doing
    // the page first would leave the chunks readable only under the old grant while the page claims
    // the new one, and a half-moved page is invisible to retrieval in one direction or the other.
    //
    // SUB-BATCHED, and "it is only two UPDATEs" is exactly the reasoning that made this wrong.
    // `content_chunks.acl` is GIN-indexed (schema.sql:261) and the table also carries an HNSW index
    // on a 1536-dim vector (:264) and a GIN FTS index on `content` (0006). Updating an INDEXED column
    // means Postgres cannot do a heap-only-tuple update, so every touched row is rewritten and
    // re-inserted into ALL of those indexes — including an HNSW graph insert at ~1-3 ms each. A
    // full 250-page batch is ~25,000 rewrites, i.e. tens of seconds, against a per-statement
    // DB_STATEMENT_TIMEOUT of 15 s (config.ts:32) — so the op did not merely run slow, it aborted
    // with 57014 and surfaced as a 500 having already moved some pages.
    //
    // Bounding CHUNK ROWS per statement rather than pages per statement, because pages vary by three
    // orders of magnitude: one dense spreadsheet can carry more chunks than two hundred memos.
    // The transaction still spans every statement — statement_timeout is per statement, and
    // idle_in_transaction only counts time spent NOT executing — so atomicity is unchanged.
    const counts = await tx<{ page_id: string; n: number }[]>`
      select page_id, count(*)::int as n from content_chunks
       where page_id = any(${moving}::uuid[]) group by page_id`;
    const chunkCount = new Map(counts.map((c) => [c.page_id, c.n]));

    let batch: string[] = [];
    let batchRows = 0;
    const flushChunks = async (): Promise<void> => {
      if (batch.length === 0) return;
      await tx`update content_chunks set acl = ${acl} where page_id = any(${batch}::uuid[])`;
      batch = [];
      batchRows = 0;
    };
    for (const id of moving) {
      const n = chunkCount.get(id) ?? 0;
      // Flush BEFORE adding when this page would push us over, so a single page larger than the
      // budget still goes alone rather than being dropped or splitting a page across statements.
      if (batchRows > 0 && batchRows + n > MAX_CHUNK_ROWS_PER_UPDATE) await flushChunks();
      batch.push(id);
      batchRows += n;
    }
    await flushChunks();
    const moved = await tx<{ id: string; slug: string }[]>`
      update pages set scope = ${scope}, acl = ${acl}, updated_at = now()
       where id = any(${moving}::uuid[])
       returning id, slug`;

    for (const m of moved) outcomes.push({ pageId: m.id, slug: m.slug, ok: true, code: 'ok' });
    return { rescoped: moved.length, scope, outcomes };
  });
}

export interface ReplacePageInput extends PageRef {
  body: string;
  title?: string;
  tags?: string[];
}

export interface ReplacePageResult {
  pageId: string;
  slug: string;
  chunkCount: number;
}

export async function replacePage(ctx: OperationContext, input: ReplacePageInput): Promise<ReplacePageResult> {
  requireOneRef(input);

  // ── Phase 1: confirm it exists and may be replaced, BEFORE paying to embed ──
  // Every reason to refuse is checked here rather than after the embedding call, so a rejected
  // replace costs nothing. The embed is the only expensive step in this op and it is unrecoverable
  // spend once made.
  const target = await withScopedTx(ctx, async (tx) => {
    const page = await resolvePage(tx, input);
    requireWriteAccess(ctx, page, 'replace');
    const hasSource =
      (await tx<{ n: number }[]>`select count(*)::int as n from page_sources where page_id = ${page.id}`)[0]!.n > 0;
    return { ...page, hasSource };
  });

  if (target.hasSource) {
    // Refused rather than handled, because every way of handling it destroys something silently.
    // Overwriting the body would leave the retained file describing content that is no longer
    // indexed — so a citation reading "p.7 of the contract" would point into a document that no
    // longer matches the answer it supports. Clearing the file instead would delete the only copy of
    // a user's upload as a side effect of an edit they did not describe as destructive.
    //
    // Making them run delete_page first is one extra call, and it makes the file going away the
    // thing they actually asked for.
    throw new OperationError(
      'invalid_params',
      `page "${target.slug}" was created from an uploaded file, so its text cannot be replaced by pasted content`,
      'Use delete_page and then ingest the corrected file. That keeps the stored file and the indexed text describing the same document.',
    );
  }

  const chunks = chunkText(input.body);
  // Refuse a zero-chunk replacement rather than committing a de-indexed page. `body` passes
  // `min(1)` for a single space, chunkText returns [] for whitespace-only text, and the delete
  // below has already removed every existing chunk — so without this the page survives, invisible
  // to search, and the op returns ok with chunkCount 0. importFile refuses exactly this state; the
  // two write paths must agree on what an empty result means.
  if (chunks.length === 0) {
    throw new OperationError(
      'invalid_params',
      'the replacement text produced no chunks',
      'Provide body text with at least one word.',
    );
  }

  // Embed OUTSIDE any transaction (D6): a stalled model call must never pin a pooled connection, and
  // DB_IDLE_IN_TX_TIMEOUT (15s) would abort the transaction under it anyway.
  const embeddings =
    chunks.length === 0
      ? []
      : await withRouterScope({ workspaceId: ctx.workspaceId, zdr: false }, () => embedAll(chunks.map((c) => c.text)));

  // ── Phase 2: swap chunks and update the page, atomically ──
  return withScopedTx(ctx, async (tx) => {
    // Re-read scope/acl HERE, from the row, under a lock — never from phase 1's snapshot and never
    // from a caller-supplied param. Two separate reasons:
    //
    //   * A param would let a caller stamp chunks with an acl that differs from their page's. That
    //     is chunk-acl drift, which filters chunks INDEPENDENTLY of their page: search silently
    //     returns fewer hits and nothing errors. `bun run doctor` counts exactly this state.
    //   * Without FOR UPDATE the read and the insert below sit in different READ COMMITTED
    //     snapshots, so a concurrent re-scope (the D68 path) could commit between them and leave the
    //     new chunks stamped with the OLD acl.
    // effective_date/author come along for the ride so the regenerated chunks carry the PAGE's
    // existing values forward (migration 0014's denormalization) rather than going NULL on every
    // replace — replace_page does not accept new values for either; it only carries the old ones.
    const locked = await tx<{ id: string; slug: string; acl: string[]; tags: string[]; effective_date: Date | null; author: string | null }[]>`
      select id, slug, acl, tags, effective_date, author from pages where id = ${target.id} for update`;
    const page = locked[0];
    // Deleted between the two phases — while we were embedding, which is the longest gap in the op.
    if (!page) {
      throw new OperationError('not_found', `page ${target.id} was deleted while its replacement was being prepared`);
    }

    // RLS-filtered, like every statement on this handle. A chunk whose acl has drifted out of the
    // caller's reach survives this delete and then coexists with the new ones — a duplicate in the
    // index that nothing here can see or remove. Not silently tolerable and not fixable from inside
    // a scoped transaction, which is the point: `bun run doctor` detects drift on the owner pool,
    // where the question can actually be asked.
    await tx`delete from content_chunks where page_id = ${page.id}`;

    const tags = input.tags ?? page.tags;

    if (chunks.length > 0) {
      const values = chunks.map((chunk, i) => ({
        workspace_id: ctx.workspaceId,
        page_id: page.id,
        acl: page.acl, // from the locked row — see above
        tags,
        ord: chunk.index,
        content: chunk.text,
        // estimateTokens (UTF-8 bytes), not text.length/4 — the latter under-counts Devanagari and
        // Tamil by ~4x, and embedAll/planBatches size their batches from estimateTokens. All three
        // writers of this column must agree or a future re-embed disagrees with the batch planner.
        token_count: estimateTokens(chunk.text),
        embedding: toVectorLiteral(embeddings[i]!),
        // Carried forward from the locked page row, not re-derived — see the comment on `locked` above.
        effective_date: page.effective_date,
        author: page.author,
        chunker_version: CHUNKER_VERSION,
      }));
      await tx`
        insert into content_chunks ${tx(values, 'workspace_id', 'page_id', 'acl', 'tags', 'ord', 'content', 'token_count', 'embedding', 'effective_date', 'author', 'chunker_version')}`;
    }

    // This UPDATE is the FIRST writer of updated_at anywhere in the codebase — importPage and
    // importFile still only insert, so a page that has never been replaced carries its creation
    // time here. M6's Drive change detection compares against this column, so a replace that left
    // it stale would make a re-synced document look untouched.
    //
    // scope and acl are deliberately absent from this UPDATE: re-scoping is a separate operation
    // with its own hazard (D68 — promoting a private page can now collide with a shared slug and
    // must handle 23505), and smuggling it into "replace the body" would ship that hazard unhandled.
    //
    // content_hash IS recomputed here, unlike scope/acl above: its entire meaning is "hash of the
    // CURRENT content" (migration 0014), so leaving it stale the first time a page is edited would
    // defeat the reason it exists before it has a single consumer.
    await tx`
      update pages
         set body = ${input.body},
             -- coalesce, so omitting the title keeps the existing one rather than nulling it.
             title = coalesce(${input.title ?? null}, title),
             tags = ${tags},
             content_hash = ${textHash(input.body)},
             updated_at = now()
       where id = ${page.id}`;

    // M9: a replace must re-run extraction — the body changed, so stale edges must be deleted and
    // any new ones written. Pure regex/mention work (no LLM call), safe inside this transaction
    // per D6.
    await extractAndReconcileLinks(tx, { workspaceId: ctx.workspaceId, pageId: page.id, pageAcl: page.acl, text: input.body });

    return { pageId: page.id, slug: page.slug, chunkCount: chunks.length };
  });
}

/** Upper bound on the text `get_page` will return in one call.
 *
 *  Every other read in the registry is bounded — `list_pages` caps limit at 200, `search` at 20,
 *  `ask.question` at 2,000 — and operations.ts states the house rule: every bound turns a 500 into a
 *  diagnosable 400. `get_page` shipped as the only unbounded one, over a column whose own migration
 *  comment calls it "deliberately UNBOUNDED". M4's rung-0 meter does not substitute; dispatch.ts says
 *  outright it is a RATE meter, not a size cap, so 120 calls/min against a page extracted from a 5 MB
 *  spreadsheet is unbounded response bytes from a single-process server.
 *
 *  Generous on purpose: this is a whole-document read and truncating a normal document would make the
 *  op useless. It exists so a pathological row cannot take the process with it. */
export const MAX_PAGE_CONTENT_CHARS = 1_000_000;

/** A page plus its full text. `PageSummary` deliberately carries no text — a list of 50 pages should
 *  not drag 50 documents across the wire — so this is the detail view. */
export interface PageDetail extends PageSummary {
  /** The document's text, from the authoritative column.
   *
   *  This USED TO join the chunk rows back together, and that was wrong in a way no test caught:
   *  chunks OVERLAP by construction (chunkText carries a 50-word trailing overlap, and the block
   *  chunker adds a 12% ratio on top), so the "document" repeated up to 50 words at every boundary.
   *  Measured: 700 words in, 750 words out. Every get_page test seeded a single-chunk body, so the
   *  overlap never occurred.
   *
   *  It was justified by a comment claiming `pages` has no body column. It has two: `pages.body`
   *  holds pasted text (import.ts writes it) and `pages.extracted_text` holds the full extracted text
   *  for file-sourced pages (migration 0009, NULL for pasted). The chunk join survives only as a
   *  fallback for rows predating 0009, where it is the sole remaining source. */
  content: string;
  /** True when `content` hit MAX_PAGE_CONTENT_CHARS. A truncated read must be visibly truncated
   *  rather than silently short — a client cannot tell the difference from the text alone. */
  truncated: boolean;
}

/**
 * Read one page and its text.
 *
 * Added at M5 Phase 1 because there was NO way to read a page's content back through the API.
 * `list_pages` returns metadata only, `search` returns matching chunks, and `ask` returns whatever
 * the retriever chose.
 *
 * AGENT-FACING FOR NOW, and that is worth stating rather than implying. The motivation above was
 * written as a UI outcome ("a UI could show that a document existed and never show the document"),
 * and M5a does not close it: nothing in `web/` calls this op, `PageList` rows are not interactive,
 * and `docs/screens.md` has no page-detail screen. What this DID close is the API capability — it is
 * live on REST, MCP `tools/list` and the CLI, which is where an agent reads a document back. The UI
 * half is M5b; see the page-detail row in docs/screens.md.
 */
export async function getPage(ctx: OperationContext, ref: PageRef): Promise<PageDetail> {
  requireOneRef(ref);
  return withScopedTx(ctx, async (tx) => {
    // resolvePage applies the same id-or-slug rules (and the same ambiguity error) every other
    // lifecycle op uses, rather than a second lookup that could disagree with them.
    const page = await resolvePage(tx, ref);
    // ONE statement, not three. It used to run resolvePage, then read every chunk, then re-read the
    // same pages row by the same id — and that third query recomputed `count(*)` over the chunks it
    // had already fetched, under the identical RLS predicate, so the number was provably rows.length.
    // At this repo's own measured ~110ms per round trip (hybrid.ts) that was ~220ms of pure waste.
    const meta = await tx<(PageRow & { text: string | null; over: boolean })[]>`
      select
        p.id, p.slug, p.title, p.kind, p.scope, p.tags, p.source_format,
        exists (select 1 from page_sources s where s.page_id = p.id) as has_source,
        (select count(*)::int from content_chunks c where c.page_id = p.id) as chunk_count,
        -- The AUTHORITATIVE text. body for pasted pages, extracted_text for file-sourced ones.
        -- Truncation happens in SQL so an oversized document is never materialised in this process.
        left(coalesce(p.body, p.extracted_text), ${MAX_PAGE_CONTENT_CHARS}) as text,
        length(coalesce(p.body, p.extracted_text)) > ${MAX_PAGE_CONTENT_CHARS} as over,
        p.created_at, p.updated_at
      from pages p where p.id = ${page.id}`;
    const m = meta[0];
    if (!m) throw new OperationError('not_found', 'page not found');
    if (m.text !== null) return { ...toSummary(m), content: m.text, truncated: m.over === true };

    // FALLBACK, and only for rows that predate migration 0009 — a file ingest from before
    // extracted_text existed has its text nowhere but the chunks. Rejoining them duplicates the
    // chunk overlap, so this path is lossy by nature; it is reached only when the alternative is
    // returning nothing at all.
    //
    // No workspace_id or acl predicate: RLS is the SOLE scoper here exactly as it is for the page
    // row above. A chunk whose acl drifted out of view is simply absent, which is the same behaviour
    // search has, rather than a partial read that silently claims to be complete.
    const rows = await tx<{ content: string }[]>`
      select content from content_chunks where page_id = ${page.id} order by ord`;
    const joined = rows.map((r) => r.content).join('\n\n');
    return {
      ...toSummary(m),
      content: joined.slice(0, MAX_PAGE_CONTENT_CHARS),
      truncated: joined.length > MAX_PAGE_CONTENT_CHARS,
    };
  });
}
