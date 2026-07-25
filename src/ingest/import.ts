// The ingest waist: chunk -> embed (outside any tx) -> one atomic write of page + chunks.
// Structure mirrors gbrain's import-file.ts "embed-before-tx, then one atomic tx" pattern
// (see docs/plan.md's M3 section) — this IS M3's ingest first draft, not throwaway spike code.
// A17 scope: markdown/plain-text only, no content-sanity gate, no dedup (all legitimate M3
// hardening layered on top of this waist later).
import { aclForScope, DEFAULT_PAGE_SCOPE, type OperationContext, type PageScope } from '../core/context.ts';
import { withScopedTx } from '../db/client.ts';
import { embed, withRouterScope } from '../ai/router.ts';
import { toVectorLiteral } from '../ai/vector.ts';
import { chunkText } from './chunk.ts';
import { OperationError } from '../api/errors.ts';

export interface ImportPageInput {
  slug: string;
  title: string;
  body: string;
  tags?: string[];
  scope?: PageScope;
}

export interface ImportPageResult {
  pageId: string;
  chunkCount: number;
}

export async function importPage(ctx: OperationContext, input: ImportPageInput): Promise<ImportPageResult> {
  const chunks = chunkText(input.body);
  const tags = input.tags ?? [];
  // The acl is DERIVED from the scope — never stamped independently. `scope` names a visibility
  // policy and `acl` is what the database enforces (`acl && grants`); computing one from the other
  // makes a mismatched pair unrepresentable. See aclForScope in core/context.ts for why that
  // matters more than it looks: at M4 the enforced predicate reads the ACL and never the label.
  const scope = input.scope ?? DEFAULT_PAGE_SCOPE;
  const acl = aclForScope(scope, ctx);

  // Embed OUTSIDE any DB transaction (D6) — a stalled model call must never pin a pooled
  // connection. Skip the call entirely for an empty body (embed([]) has no well-defined contract).
  const embeddings =
    chunks.length === 0
      ? []
      : await withRouterScope({ workspaceId: ctx.workspaceId, zdr: false }, () => embed(chunks.map((c) => c.text)));

  return withScopedTx(ctx, async (tx) => {
    let rows: { id: string }[];
    try {
      rows = await tx<{ id: string }[]>`
        insert into pages (workspace_id, slug, title, tags, owner_principal, scope, acl, body)
        values (${ctx.workspaceId}, ${input.slug}, ${input.title}, ${tags}, ${ctx.principal}, ${scope}, ${acl}, ${input.body})
        returning id`;
    } catch (err) {
      // Re-ingesting an existing slug is the single most ordinary ingest mistake, and it used to
      // surface as `500 internal_error` with "Reference reqId … in server logs" — after every chunk
      // had already been embedded and paid for. ONLY the slug collision is translated; any other
      // 23505 (or any other error) rethrows, because mapping an unknown constraint to "already
      // exists" would report the wrong cause.
      const e = err as { code?: string; constraint_name?: string };
      if (e.code === '23505' && e.constraint_name === 'pages_workspace_id_slug_key') {
        throw new OperationError(
          'already_exists',
          `a page with slug "${input.slug}" already exists in this workspace`,
          'Choose a different slug, or delete the existing page first.',
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
        token_count: Math.ceil(chunk.text.length / 4),
        embedding: toVectorLiteral(embeddings[i]!),
      }));
      await tx`
        insert into content_chunks ${tx(values, 'workspace_id', 'page_id', 'acl', 'tags', 'ord', 'content', 'token_count', 'embedding')}`;
    }

    return { pageId, chunkCount: chunks.length };
  });
}
