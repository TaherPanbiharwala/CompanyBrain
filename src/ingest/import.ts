// The ingest waist: chunk -> embed (outside any tx) -> one atomic write of page + chunks.
// Structure mirrors gbrain's import-file.ts "embed-before-tx, then one atomic tx" pattern
// (see docs/plan.md's M3 section) — this IS M3's ingest first draft, not throwaway spike code.
// A17 scope: markdown/plain-text only, no content-sanity gate, no dedup (all legitimate M3
// hardening layered on top of this waist later).
import { aclForScope, DEFAULT_PAGE_SCOPE, type OperationContext, type PageScope } from '../core/context.ts';
import { DEFAULT_PACK_KIND, type PackKind } from '../core/pack.ts';
import { withScopedTx } from '../db/client.ts';
import { withRouterScope, type RouterBudget } from '../ai/router.ts';
import { toVectorLiteral } from '../ai/vector.ts';
import type postgres from 'postgres';
import { chunkText, estimateTokens, CHUNKER_VERSION } from './chunk.ts';
import { embedAll } from './embed.ts';
import { deriveEffectiveDate, textHash as computeTextHash } from './provenance.ts';
import { OperationError } from '../api/errors.ts';
import { extractAndReconcileLinks } from '../core/links/reconcile.ts';

export interface ImportPageInput {
  slug: string;
  title: string;
  body: string;
  tags?: string[];
  scope?: PageScope;
  kind?: PackKind;
  /** Who WROTE the document (not who uploaded it — that is owner_principal). */
  author?: string;
  /** Unstructured metadata bag. Bounded to 10KB at the op boundary (src/api/operations.ts). */
  metadata?: Record<string, unknown>;
  /** ISO date (YYYY-MM-DD) the document is ABOUT. Omit to default to the upload date. */
  effectiveDate?: string;
}

export interface ImportPageResult {
  pageId: string;
  chunkCount: number;
}

/** Trusted server-only options. They are intentionally absent from ImportPageInput, which is the
 * shape reached by the public ingest operation. */
export interface ImportPageOptions {
  budget?: RouterBudget;
}

export async function importPage(
  ctx: OperationContext,
  input: ImportPageInput,
  opts?: ImportPageOptions,
): Promise<ImportPageResult> {
  const chunks = chunkText(input.body);
  const tags = input.tags ?? [];
  // The acl is DERIVED from the scope — never stamped independently. `scope` names a visibility
  // policy and `acl` is what the database enforces (`acl && grants`); computing one from the other
  // makes a mismatched pair unrepresentable. See aclForScope in core/context.ts for why that
  // matters more than it looks: at M4 the enforced predicate reads the ACL and never the label.
  const scope = input.scope ?? DEFAULT_PAGE_SCOPE;
  const acl = aclForScope(scope, ctx);
  const kind = input.kind ?? DEFAULT_PACK_KIND;
  const { effectiveDate, effectiveDateSource } = deriveEffectiveDate(input.effectiveDate);
  // Hashes the BODY text directly — this path has no separate "extracted" text (body IS the
  // content), the same reason it never wrote source_sha256 either. See provenance.ts's textHash()
  // for why this means the same thing as file.ts's ingest path.
  const textHash = computeTextHash(input.body);

  // Embed OUTSIDE any DB transaction (D6) — a stalled model call must never pin a pooled
  // connection. embedAll batches, so a document large enough to exceed the provider's input limit
  // or EMBED_TIMEOUT_MS still completes instead of losing every chunk already paid for.
  const embeddings =
    chunks.length === 0
      ? []
      : await withRouterScope({ workspaceId: ctx.workspaceId, zdr: false, budget: opts?.budget }, () =>
          embedAll(chunks.map((c) => c.text)),
        );

  return withScopedTx(ctx, async (tx) => {
    let rows: { id: string }[];
    try {
      // `kind` is written EXPLICITLY now. Migration 0004's comment recorded that nothing wrote it —
      // "every page takes the DDL default until the ingest op exposes it" — so all 12 live pages are
      // 'note' regardless of what they contain. Passing it here is what makes that comment stale in
      // the good direction.
      rows = await tx<{ id: string }[]>`
        insert into pages (
          workspace_id, slug, title, kind, tags, owner_principal, scope, acl, body,
          author, metadata, effective_date, effective_date_source, content_hash
        )
        values (
          ${ctx.workspaceId}, ${input.slug}, ${input.title}, ${kind}, ${tags}, ${ctx.principal}, ${scope}, ${acl}, ${input.body},
          ${input.author ?? null}, ${input.metadata ? tx.json(input.metadata as postgres.JSONValue) : null},
          ${effectiveDate}, ${effectiveDateSource}, ${textHash}
        )
        returning id`;
    } catch (err) {
      // Re-ingesting an existing slug is the single most ordinary ingest mistake, and it used to
      // surface as `500 internal_error` with "Reference reqId … in server logs" — after every chunk
      // had already been embedded and paid for. ONLY the slug collision is translated; any other
      // 23505 (or any other error) rethrows, because mapping an unknown constraint to "already
      // exists" would report the wrong cause.
      //
      // TWO index names. 0007 replaced UNIQUE(workspace_id, slug) with two partial unique indexes
      // because the single constraint made another principal's INVISIBLE private slug enumerable
      // (unique checks bypass RLS, and this handler echoes the slug back). Migration 0018 renamed
      // both to the "_live" suffix (adding `AND deleted_at IS NULL` so a soft-deleted page's slug
      // becomes reusable) — this map must track that name, not the original 0007 one. If this map
      // falls out of sync with the migrations, the friendly 409 silently becomes a 500 on the most
      // common mistake there is.
      //
      // 0009's source_sha256 pair is deliberately ABSENT: importPage never writes source_sha256 and
      // both of those indexes are partial on `IS NOT NULL`, so this path cannot raise them. The live
      // copy lives in src/ingest/file.ts, next to the code that can. Keyed by index name so an
      // unlisted 23505 still rethrows rather than being guessed at.
      const e = err as { code?: string; constraint_name?: string };
      const COLLISIONS: Record<string, { message: string; suggestion: string }> = {
        pages_ws_slug_shared_live: {
          message: `a page with slug "${input.slug}" already exists in this workspace`,
          suggestion: 'Choose a different slug, or delete the existing page first.',
        },
        pages_ws_slug_private_live: {
          message: `you already have a private page with slug "${input.slug}"`,
          suggestion: 'Choose a different slug, or delete your existing page first.',
        },
      };
      const collision = e.code === '23505' && e.constraint_name ? COLLISIONS[e.constraint_name] : undefined;
      if (collision) {
        throw new OperationError('already_exists', collision.message, collision.suggestion);
      }
      // A policy denial on the write. Unreachable while aclForScope is the only stamper (the writer
      // always holds the tag it stamps), and reachable the moment anything writes on another
      // principal's behalf — the succession/re-scope path. Mapping it here rather than there means
      // the first such writer gets a real error instead of a 500 with a reqId an agent cannot use.
      if (e.code === '42501') {
        throw new OperationError(
          'permission_denied',
          `the database refused this write: the page acl [${acl.join(', ')}] does not overlap your grants`,
          "A page can only be written with scope 'private' (acl self:<you>) or scope 'workspace' " +
            '(acl ws:<workspace>). Call whoami to see the grants you actually hold.',
        );
      }
      throw err;
    }
    const pageId = rows[0]?.id;
    if (!pageId) throw new Error('importPage: page insert returned no id');

    // ONE insert for every chunk, not one per chunk. This was a round trip each — ~110ms apiece on
    // an intercontinental link — so a 40-chunk document spent ~4.4 SECONDS inside the transaction
    // doing nothing but waiting, holding a pooled connection the whole time (D6's scarce resource).
    //
    // postgres.js expands an array of objects into a multi-row VALUES list when the columns are named
    // in the helper, which keeps every value a bind parameter — no string concatenation into SQL. The
    // `embedding` column is the one exception the driver cannot type: pgvector has no bind format, so
    // it stays a text literal cast in the SQL, exactly as before.
    if (chunks.length > 0) {
      const values = chunks.map((chunk, i) => ({
        workspace_id: ctx.workspaceId,
        page_id: pageId,
        acl,
        tags,
        ord: chunk.index,
        content: chunk.text,
        // estimateTokens (UTF-8 bytes), not text.length/4 — see the note in lifecycle.ts. All three
        // writers of content_chunks.token_count use the same estimator.
        token_count: estimateTokens(chunk.text),
        embedding: toVectorLiteral(embeddings[i]!),
        effective_date: effectiveDate,
        author: input.author ?? null,
        chunker_version: CHUNKER_VERSION,
      }));
      await tx`
        insert into content_chunks ${tx(values, 'workspace_id', 'page_id', 'acl', 'tags', 'ord', 'content', 'token_count', 'embedding', 'effective_date', 'author', 'chunker_version')}`;
    }

    // M9: backlinks populate on ingest. Pure regex/mention work (no LLM call), so it's safe inside
    // this transaction per D6 — that rule is about never holding a transaction open across a
    // provider round-trip, which this never does.
    await extractAndReconcileLinks(tx, { workspaceId: ctx.workspaceId, pageId, pageAcl: acl, text: input.body });

    return { pageId, chunkCount: chunks.length };
  });
}
