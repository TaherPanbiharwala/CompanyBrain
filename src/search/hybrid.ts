// Hybrid search: keyword (Postgres full-text) + vector (pgvector HNSW cosine) fused via RRF.
// Pattern ported from gbrain's src/core/search/hybrid.ts (keyword + vector -> RRF fusion) under
// MIT — see NOTICE. Simplified for the A17 spike: two arms only (no title/relational arms, no
// dedup/rerank/alias-hop/query-expansion/autocut — legitimate M3 hardening on top of this).
//
// Tenant isolation: RLS is the SOLE scoper on both arms (no explicit workspace_id predicate),
// matching the established get_workspace/list_members convention (review AM12) — company-brain's
// real DB-enforced RLS is already a stronger version of gbrain's own app-level source_id filter.
import type { OperationContext } from '../core/context.ts';
import { withScopedTx } from '../db/client.ts';
import { embed, withRouterScope } from '../ai/router.ts';
import { toVectorLiteral } from '../ai/vector.ts';
import { rrfFuse } from './rrf.ts';

export interface ChunkHit {
  chunkId: string;
  pageId: string;
  slug: string;
  ord: number;
  content: string;
}

interface ChunkRow {
  chunk_id: string;
  page_id: string;
  slug: string;
  ord: number;
  content: string;
}

const DEFAULT_TOP_K = 8;
const ARM_LIMIT = 20; // candidates fetched per arm before RRF fusion narrows to topK

export async function hybridSearch(
  ctx: OperationContext,
  query: string,
  opts?: { topK?: number },
): Promise<ChunkHit[]> {
  const topK = opts?.topK ?? DEFAULT_TOP_K;

  // Embed OUTSIDE any DB transaction (D6).
  const [queryVector] = await withRouterScope({ workspaceId: ctx.workspaceId, zdr: false }, () => embed([query]));
  const vectorLiteral = toVectorLiteral(queryVector!);

  const { keywordRows, vectorRows } = await withScopedTx(ctx, async (tx) => {
    const keywordRows = await tx<ChunkRow[]>`
      select c.id as chunk_id, c.page_id, p.slug, c.ord, c.content
      from content_chunks c
      join pages p on p.id = c.page_id
      where to_tsvector('english', c.content) @@ plainto_tsquery('english', ${query})
      order by ts_rank_cd(to_tsvector('english', c.content), plainto_tsquery('english', ${query})) desc
      limit ${ARM_LIMIT}`;

    // `embedding is not null` is explicit rather than incidental. The column is nullable by design
    // (deferred/background embedding stays possible — migration 0004), and a NULL only sorts last
    // because NULLS LAST is the default for ASC: a property of the sort DIRECTION, not a statement
    // about relevance. So the filter is not about ordering — an earlier version of this comment
    // claimed un-embedded rows would "consume ARM_LIMIT slots", which NULLS LAST already prevents
    // whenever there are ARM_LIMIT embedded rows to fill them.
    //
    // What it actually buys: on a SMALL or freshly-ingested workspace, where fewer than ARM_LIMIT
    // chunks carry an embedding, the tail of this result would otherwise be un-embedded rows in
    // arbitrary order — rows the vector arm has expressed no opinion about — which then enter RRF
    // fusion as if they were ranked candidates. The filter keeps the vector arm's output to rows it
    // actually scored.
    const vectorRows = await tx<ChunkRow[]>`
      select c.id as chunk_id, c.page_id, p.slug, c.ord, c.content
      from content_chunks c
      join pages p on p.id = c.page_id
      where c.embedding is not null
      order by c.embedding <=> ${vectorLiteral}::vector
      limit ${ARM_LIMIT}`;

    return { keywordRows, vectorRows };
  });

  const byId = new Map<string, ChunkRow>();
  for (const row of [...keywordRows, ...vectorRows]) byId.set(row.chunk_id, row);

  const fused = rrfFuse([keywordRows.map((r) => r.chunk_id), vectorRows.map((r) => r.chunk_id)]);

  return fused.slice(0, topK).map(({ id }) => {
    const row = byId.get(id)!;
    return { chunkId: row.chunk_id, pageId: row.page_id, slug: row.slug, ord: row.ord, content: row.content };
  });
}
