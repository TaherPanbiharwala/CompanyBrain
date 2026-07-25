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
import { RRF_K } from './rrf.ts';

export interface ChunkHit {
  chunkId: string;
  pageId: string;
  slug: string;
  ord: number;
  content: string;
}

interface FusedRow {
  chunk_id: string;
  page_id: string;
  slug: string;
  ord: number;
  content: string;
  score: string; // numeric arrives as a string from postgres.js
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

  // ONE statement, not two. MEASURED, because the obvious answers were wrong (see DECISIONS D65):
  //   * `Promise.all` on the two arms saved exactly NOTHING — a transaction holds one connection and
  //     postgres.js runs its statements in order on it, so concurrency at the JS level buys no
  //     parallelism at the wire level.
  //   * Dropping the `pages` JOIN saved 1ms, and fetching full `content` for 40 candidates instead
  //     of 8 cost 13ms. Both were on the plan; neither was worth doing.
  //   * The real cost is per-STATEMENT: every extra round trip on this link is ~110ms, and the
  //     ::vector cast of a 1536-element literal is a second one all by itself (parse cost on the
  //     server, not bytes — cutting the literal 39% smaller saved 11ms).
  // So the win is to issue fewer statements, and fusion moves into SQL to make that possible:
  // 930ms -> 691ms for the search leg.
  //
  // The fusion arithmetic MUST match rrfFuse exactly. Two traps, both live here:
  //   * rrfFuse ranks from ZERO (`1/(k + rank)`), row_number() starts at ONE — hence `rk - 1`.
  //   * ties are common in RRF and must break the same way, hence `order by score desc, id` against
  //     rrfFuse's id tie-break.
  // test/hybrid.test.ts asserts the two agree on real data, so rrfFuse remains the specification and
  // this is the fast path that has to match it.
  const rows = await withScopedTx(ctx, (tx) => tx<FusedRow[]>`
    with kw as (
      select c.id,
             row_number() over (
               order by ts_rank_cd(to_tsvector('english', c.content), plainto_tsquery('english', ${query})) desc
             ) as rk
      from content_chunks c
      where to_tsvector('english', c.content) @@ plainto_tsquery('english', ${query})
      limit ${ARM_LIMIT}
    ),
    -- embedding IS NOT NULL is explicit rather than incidental. The column is nullable by design
    -- (deferred/background embedding stays possible — migration 0004), and a NULL only sorts last
    -- because NULLS LAST is the default for ASC: a property of the sort DIRECTION, not a statement
    -- about relevance. On a small or freshly-ingested workspace the tail would otherwise be rows the
    -- vector arm has expressed no opinion about, entering fusion as if they were ranked candidates.
    vec as (
      select c.id, row_number() over (order by c.embedding <=> ${vectorLiteral}::vector) as rk
      from content_chunks c
      where c.embedding is not null
      limit ${ARM_LIMIT}
    ),
    fused as (
      select id, sum(1.0 / (${RRF_K} + rk - 1)) as score
      from (select id, rk from kw union all select id, rk from vec) u
      group by id
      order by score desc, id
      limit ${topK}
    )
    select c.id as chunk_id, c.page_id, p.slug, c.ord, c.content, f.score
    from fused f
    join content_chunks c on c.id = f.id
    join pages p on p.id = c.page_id
    order by f.score desc, c.id`);

  return rows.map((r) => ({
    chunkId: r.chunk_id,
    pageId: r.page_id,
    slug: r.slug,
    ord: r.ord,
    content: r.content,
  }));
}
