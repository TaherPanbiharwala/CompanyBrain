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
import { chunkText, estimateTokens } from './chunk.ts';
import { embedAll } from './embed.ts';
import { OperationError } from '../api/errors.ts';
import type { OperationContext } from '../core/context.ts';
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

  return {
    hasMore,
    pages: page.map((r) => ({
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
    })),
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
function requireWriteAccess(ctx: OperationContext, page: ResolvedPage, verb: string): void {
  if (page.owner_principal === ctx.principal) return;
  if (ctx.role === 'admin' || ctx.role === 'owner') return;
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
  sourceRemoved: boolean;
}

export async function deletePage(ctx: OperationContext, ref: PageRef): Promise<DeletePageResult> {
  requireOneRef(ref);
  return withScopedTx(ctx, async (tx) => {
    const page = await resolvePage(tx, ref);
    requireWriteAccess(ctx, page, 'delete');

    // Checked BEFORE the delete, because after it the row is gone and the answer is unknowable. It
    // is the one destructive side effect the caller may not have in mind: the original uploaded file
    // is stored only here (D71), so this delete is the last copy going away.
    const hadSource =
      (await tx<{ n: number }[]>`select count(*)::int as n from page_sources where page_id = ${page.id}`)[0]!.n > 0;

    const deleted = await tx<{ id: string }[]>`delete from pages where id = ${page.id} returning id`;
    // resolvePage saw it a moment ago inside this same transaction, so an empty result here is not
    // "already gone" — it would mean DELETE and SELECT disagree about the policy, which is a bug
    // worth failing on rather than reporting as success.
    if (deleted.length === 0) {
      throw new OperationError('permission_denied', 'the database refused to delete a page you can read');
    }

    // Chunks and stored bytes go with it through the composite FKs' ON DELETE CASCADE. NOT deleted
    // explicitly first, and that is the correct choice rather than a shortcut: an explicit
    // `delete from content_chunks where page_id = …` runs under RLS, so a chunk whose acl has
    // drifted out of the caller's reach would survive it — while the cascade, running as the table
    // owner during referential integrity, removes every child unconditionally. The looser-looking
    // mechanism is the one that actually leaves nothing behind.
    return { pageId: page.id, slug: page.slug, sourceRemoved: hadSource };
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
    const locked = await tx<{ id: string; slug: string; acl: string[]; tags: string[] }[]>`
      select id, slug, acl, tags from pages where id = ${target.id} for update`;
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
      }));
      await tx`
        insert into content_chunks ${tx(values, 'workspace_id', 'page_id', 'acl', 'tags', 'ord', 'content', 'token_count', 'embedding')}`;
    }

    // This UPDATE is the FIRST writer of updated_at anywhere in the codebase — importPage and
    // importFile still only insert, so a page that has never been replaced carries its creation
    // time here. M6's Drive change detection compares against this column, so a replace that left
    // it stale would make a re-synced document look untouched.
    //
    // scope and acl are deliberately absent from this UPDATE: re-scoping is a separate operation
    // with its own hazard (D68 — promoting a private page can now collide with a shared slug and
    // must handle 23505), and smuggling it into "replace the body" would ship that hazard unhandled.
    await tx`
      update pages
         set body = ${input.body},
             -- coalesce, so omitting the title keeps the existing one rather than nulling it.
             title = coalesce(${input.title ?? null}, title),
             tags = ${tags},
             updated_at = now()
       where id = ${page.id}`;

    return { pageId: page.id, slug: page.slug, chunkCount: chunks.length };
  });
}
