// Hybrid search: keyword (Postgres full-text) + vector (pgvector HNSW cosine) + title, fused via
// weighted RRF. Pattern ported from gbrain's src/core/search/hybrid.ts under MIT — see NOTICE.
//
// Tenant isolation: RLS is the SOLE scoper on every arm (no explicit workspace_id predicate),
// matching the established get_workspace/list_members convention (review AM12).
import type postgres from 'postgres';
import type { OperationContext } from '../core/context.ts';
import { withScopedTx } from '../db/client.ts';
import { embed, withRouterScope, rerank, isRerankEnabled, expandQuery, isExpansionEnabled } from '../ai/router.ts';
import { toVectorLiteral } from '../ai/vector.ts';
import { RRF_K } from './rrf.ts';
import { formatLocator, type Locator } from '../ingest/blocks.ts';

export interface ChunkHit {
  chunkId: string;
  pageId: string;
  slug: string;
  title: string | null;
  ord: number;
  content: string;
  /** Where in the source document this chunk came from; null for pasted text. */
  locator: Locator | null;
  /** The PRE-RENDERED locator ("p. 4", "Sheet1!A1"), or null for pasted text.
   *
   *  On the shared shape rather than projected by one op. It used to be added only inside the
   *  `search` handler, so `ask` — the only op the UI actually calls — returned hits with no
   *  citation at all and the source panel silently never showed a page number. Typecheck could not
   *  see it: the client mirrors these types by hand in a separate tsc project. */
  citation: string | null;
  /** The owning page's visibility LABEL ('private' | 'workspace'), carried so a UI can show a
   *  citation's audience without a second round trip per hit.
   *
   *  It is a label, not the control: `acl` is what RLS enforces, and this hit only exists because
   *  the acl already matched the caller's keyring. Displaying it answers "who else can see this
   *  source", which is the question a permission-scoped answer has to be able to answer — and there
   *  was no way to ask it before, because `list_pages` returned `scope` and search did not. */
  scope: string;
  /** BLENDED score: `BLEND_RRF * (rrf / max rrf) + BLEND_COS * cosine similarity`, not raw RRF.
   *  Comparable WITHIN one result set only — the normalisation is per-query. */
  score: number;
}

interface FusedRow {
  chunk_id: string;
  page_id: string;
  slug: string;
  title: string | null;
  ord: number;
  content: string;
  locator: Locator | null;
  scope: string;
  score: number; // ::float8, so postgres.js gives a number rather than numeric-as-string
}

/** EXPORTED so the eval harness can record the production default in its run manifest. A report
 *  whose numbers cannot be tied back to the topK they were produced at is not comparable with the
 *  next one — CONTEXT.md §6.7 records a committed report that described a superseded engine. */
export const DEFAULT_TOP_K = 8;

/** VECTOR-arm candidates fetched before fusion. The keyword arm is bounded by KW_OR_SLOTS and the
 *  title arm by TITLE_LIMIT; this constant no longer applies to them. */
export const ARM_LIMIT = 20;

/** How many keyword rows that matched only the OR tier may enter fusion. See KEYWORD ARM below. */
export const KW_OR_SLOTS = 10;

/** How many AND-tier rows may enter fusion. Larger than KW_OR_SLOTS because containing every term
 *  of the question is strong evidence — but bounded, because on a short query EVERY match is
 *  AND-tier and "strong evidence" stops discriminating. */
export const KW_AND_SLOTS = 20;

/** Title-arm candidates. Small on purpose: a title match is a weak signal on its own. */
export const TITLE_LIMIT = 10;

/** How many extra candidates to fetch when a reranker is on. A cross-encoder that only sees the
 *  final topK can reorder them and nothing else — the value of reranking is promoting something
 *  fusion ranked 15th, which requires having fetched a 15th. */
const RERANK_OVERFETCH = 4;

/** At most this many chunks from any single page may occupy the final result set.
 *
 *  Load-bearing, not a nicety, and increasingly so: a 50-column spreadsheet row-chunked with its
 *  header repeated produces N near-identical embeddings, so without this one sheet can occupy every
 *  slot and crowd out the page that actually answers the question.
 *
 *  3 -> 2 on 2026-08-09, from the MultiHop-RAG retrieval eval (2,255 questions, 0 degraded, 0
 *  errored; `eval/multihop-latest.md`). Replayed offline from the banked ranked lists rather than
 *  guessed:
 *
 *      all-evidence-recall@8   36.9% -> 40.3%   (+3.3pp)
 *      75 questions fixed, 0 broken
 *      by hop count: 2-doc +2.2pp, 3-doc +5.7pp, 4-doc +1.6pp
 *
 *  The gain lands on the 3-document bucket, which the same run identified as the one genuinely
 *  limited by slot budget rather than by retrieval reach. Nothing regressed at any hop count.
 *
 *  TWO CAVEATS THIS VALUE CARRIES, recorded because the numbers above look cleaner than the
 *  decision was:
 *
 *  1. It ships BELOW the threshold pre-registered before the run ("a gain under 5pp does not justify
 *     a change here"). 3.3pp < 5pp. The founder chose to ship on the strength of 75-fixed/0-broken
 *     rather than the aggregate. That is a deliberate override, not an oversight.
 *  2. It has NOT been checked against answer quality. `all-evidence-recall` counts DOCUMENTS, and
 *     63.3% of retrieved gold documents currently contribute more than one chunk — so a tighter cap
 *     trades within-document depth for document breadth, and this metric is blind to that trade by
 *     construction. The same replay says cap=1 scores +13.8pp, which is mostly the metric rewarding
 *     the configuration that maximises document count; that is the reason to distrust the larger
 *     number, and the reason this one wants a NovaByte answer-quality check before it is treated as
 *     settled. */
export const MAX_PER_PAGE = 2;

// Arm weights, positionally identical to the union order below. Exported so test/hybrid.test.ts
// fuses with the SAME numbers the SQL uses — duplicating them there would let the two drift while
// the equivalence assertion stayed green.
//
// FOUR arms, not three, because the two keyword tiers are different STRENGTHS OF EVIDENCE and one
// weight cannot say so. "Contains every word of the question" and "shares one word with it" were
// fused identically; tier ordering only moves a row within its list, which shifts rank by one or two
// and barely changes the RRF contribution.
//
// That split is MEASURED (D65), on the ten labelled A17 questions. With one shared keyword weight,
// top-1 precision fell on exactly the flooding cases the tiering was supposed to fix — q8's answer
// sits at ts_rank_cd 0.9 beneath noise at 1.5 and 1.2, and q10 is the same shape:
//
//   before this milestone   MRR 1.000   first-relevant@1 10/10   all-relevant-in-top8  9/10
//   one keyword weight      MRR 0.883   first-relevant@1  8/10   all-relevant-in-top8 10/10
//   tiers split (shipped)   MRR 0.950   first-relevant@1  9/10   all-relevant-in-top8 10/10
//
// The remaining 0.05 is q10 alone, where the first relevant document moved from rank 1 to rank 2 and
// its partner moved 4 -> 2: a reshuffle inside the relevant set, traded for a document q6 was
// missing entirely. Read those numbers with the corpus in mind — 14 chunks and 10 questions scoring
// 1.000 before any change is a saturated benchmark, which can show a SHAPE but cannot justify a
// tuned constant. The values below stay conservative and deliberately round.
export const W_KW_AND = 1.0;
export const W_KW_OR = 0.4;
export const W_VEC = 1.0;
export const W_TITLE = 0.5;

// Final re-score blend, gbrain's 0.7/0.3. Applied to the ORDERING only — the candidate SET is
// decided entirely by fusion above, so this can reorder the shortlist but never introduce a row the
// arms did not find or remove one they did.
export const BLEND_RRF = 0.7;
export const BLEND_COS = 0.3;

/**
 * Autocut: discard hits scoring below this fraction of the best hit. **0 disables it.**
 *
 * SHIPPED OFF, and that is a measurement rather than caution. Swept against the ten labelled A17
 * questions, every setting is either a no-op or destroys recall — there is no useful middle:
 *
 *   ratio 0.3 -> 0 results dropped                        (does nothing)
 *   ratio 0.5 -> 6 dropped, 2 of them RELEVANT
 *   ratio 0.7 -> 49 dropped, 4 of them RELEVANT
 *
 * The reason is visible in the score distribution: q6's second relevant document sits at 0.44 of the
 * top score, so any cut that removes anything removes it. That document is precisely the recall this
 * milestone's keyword-arm rewrite gained (it was missing from the top 8 entirely before).
 *
 * The mechanism is built, tested and logged so enabling it later is a constant change rather than a
 * rewrite — but it stays off until there is a corpus that can show it helping. Autocut is the only
 * retrieval control here that can ONLY remove results.
 */
export const AUTOCUT_RATIO = 0;

/** Drop the tail below `ratio` of the top score. Returns the dropped count so the caller can say so
 *  out loud — a silent recall cut is the failure mode this whole control has to justify itself
 *  against. */
export function autocut(hits: ChunkHit[], ratio: number = AUTOCUT_RATIO): { kept: ChunkHit[]; dropped: number } {
  if (ratio <= 0 || hits.length === 0) return { kept: hits, dropped: 0 };
  const floor = hits[0]!.score * ratio;
  const kept = hits.filter((h) => h.score >= floor);
  return { kept, dropped: hits.length - kept.length };
}

/** Terms below this length carry no retrieval signal and inflate the OR query. */
const MIN_TERM_CHARS = 3;
/** Cap on OR terms, so a 2000-character question cannot build a pathological tsquery. */
const MAX_TERMS = 32;

/**
 * Build the OR-joined query text for `websearch_to_tsquery`.
 *
 * WHY NOT `plainto_tsquery`, which the arm used until now: it ANDs every lexeme, so a chunk must
 * contain ALL of them. Measured on the A17 corpus, that returns ZERO rows for 7 of 10 eval
 * questions — the keyword arm was silently absent from most searches and the hybrid was a vector
 * search wearing a hybrid's name.
 *
 * WHY `websearch_to_tsquery` rather than casting to ::tsquery: it never raises a syntax error on any
 * input. The obvious alternative — `string_agg(lexemes, ' | ')::tsquery` — raises 42601 on a query
 * containing a URL, because URL lexemes keep `( ) & ? = !`. Measured, not hypothesized. It also means
 * no user text is ever concatenated into SQL: this returns a STRING that is passed as a bind
 * parameter, and the tokens are stripped to `[a-z0-9]` besides.
 */
export function keywordQueryText(query: string): string {
  const seen = new Set<string>();
  for (const raw of query.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < MIN_TERM_CHARS) continue;
    seen.add(raw);
    if (seen.size >= MAX_TERMS) break;
  }
  // `OR` is websearch_to_tsquery's disjunction keyword. Terms are lowercased above, so no term can
  // ever collide with it.
  return [...seen].join(' OR ');
}

/** Why a result set is worse than it should be. Absent means "nothing was wrong". */
export type SearchDegradation = 'keyword_only';

export interface SearchOutcome {
  hits: ChunkHit[];
  degraded?: SearchDegradation;
}

/** Retrieve, and say so when the answer is built on less than it should be.
 *
 *  Returns an OBJECT rather than a bare array because "we searched everything and this is what there
 *  is" and "the embedding provider was down so we only did keyword matching" produce the same-looking
 *  list, and the difference is the whole basis on which a reader decides to trust a thin answer. */
export async function hybridSearch(
  ctx: OperationContext,
  query: string,
  opts?: {
    topK?: number;
    /** Only chunks whose effective_date is on or after this ISO date (migration 0014). */
    since?: string;
    /** Only chunks whose effective_date is on or before this ISO date. */
    until?: string;
    /** Only chunks whose author matches, case- and whitespace-insensitively. */
    author?: string;
  },
): Promise<SearchOutcome> {
  const topK = opts?.topK ?? DEFAULT_TOP_K;

  // Reranking needs more candidates than it returns, or it can only reorder what fusion already
  // chose — which is the cheapest possible version of the idea and not worth a provider call.
  const fetchK = isRerankEnabled() ? topK * RERANK_OVERFETCH : topK;

  // Expansion widens the KEYWORD arm's vocabulary only, and it lands in the OR tier for free —
  // `and_tier` is computed from the ORIGINAL question, so a paraphrase can never promote a chunk
  // into the strong tier. That is exactly the standing paraphrased terms deserve, and it is why this
  // does not need a fifth arm with a fifth weight: the tier split already models "weaker evidence".
  //
  // Failure here is absorbed by expandQuery (returns []), so an expansion outage costs vocabulary,
  // never the request.
  const expansions = isExpansionEnabled()
    ? await withRouterScope({ workspaceId: ctx.workspaceId, zdr: false }, () => expandQuery(query))
    : [];
  const orQuery = keywordQueryText([query, ...expansions].join(' '));

  // Embed OUTSIDE any DB transaction (D6).
  //
  // A failure here does NOT sink the request. The router has already retried anything transient
  // (429, 5xx, timeouts) and bounded the total wait, so reaching this catch means the embedder is
  // genuinely unavailable or the key is refused — and keyword-only retrieval still answers a great
  // many questions. What is not acceptable is doing that quietly, so the degradation is carried out
  // of this function, logged here, and stated to the model in the prompt.
  let vectorLiteral: string | null = null;
  let degraded: SearchDegradation | undefined;
  try {
    const [queryVector] = await withRouterScope({ workspaceId: ctx.workspaceId, zdr: false }, () => embed([query]));
    vectorLiteral = toVectorLiteral(queryVector!);
  } catch (err) {
    degraded = 'keyword_only';
    // Counts and a code, never the query text (D28).
    console.log(JSON.stringify({
      level: 'warn',
      kind: 'retrieval_degraded',
      workspace: ctx.workspaceId,
      degraded,
      reason: (err as { providerCode?: string; status?: number }).providerCode ?? (err as { status?: number }).status ?? 'unknown',
    }));
  }
  // Gates the vector arm off entirely rather than embedding a zero vector: a zero vector is not
  // "no opinion", it is a specific point in the space, and every chunk would be ranked by distance
  // from it. With this false the CTE is empty, and `<=> NULL::vector` makes cos_sim coalesce to 0,
  // so the blend collapses to pure RRF over the surviving arms.
  const hasVector = vectorLiteral !== null;

  const rows = await withScopedTx(ctx, (tx) =>
    hybridQuery(tx, {
      query,
      orQuery,
      vectorLiteral,
      hasVector,
      fetchK,
      since: opts?.since ?? null,
      until: opts?.until ?? null,
      author: opts?.author ?? null,
    }),
  );

  let hits: ChunkHit[] = rows.map((r) => ({
    chunkId: r.chunk_id,
    pageId: r.page_id,
    slug: r.slug,
    title: r.title,
    ord: r.ord,
    content: r.content,
    locator: r.locator,
    citation: formatLocator(r.locator ?? undefined) ?? null,
    scope: r.scope,
    score: r.score,
  }));

  // ── Rerank, OUTSIDE the transaction (D6) ─────────────────────────────────
  //
  // Placement is the point: withScopedTx above has already committed, so this provider call holds no
  // pooled connection. A reranker inside the transaction would pin a tx-pooler backend for the
  // length of a third-party HTTP request, which is the exact resource D6 exists to protect.
  //
  // A failure degrades to the fused order rather than failing the request. That is a weaker promise
  // than the keyword_only degrade above, and deliberately so — losing the reranker costs ordering
  // quality within a candidate set that fusion already chose, where losing the embedder costs a
  // whole retrieval arm. Only the second is worth telling the reader about.
  if (isRerankEnabled() && hits.length > 1) {
    try {
      const scores = await withRouterScope({ workspaceId: ctx.workspaceId, zdr: false }, () =>
        rerank(query, hits.map((h) => ({ id: h.chunkId, text: h.content }))),
      );
      const byId = new Map(hits.map((h) => [h.chunkId, h]));
      const reordered = scores.map((s) => byId.get(s.id)).filter((h): h is ChunkHit => h !== undefined);
      // Only trust a complete answer. A provider that returned a subset would silently DROP the
      // chunks it omitted — a recall cut disguised as a reordering, which is the one thing the
      // autocut sweep established this codebase should not do quietly.
      if (reordered.length === hits.length) hits = reordered;
    } catch {
      // Keep the fused order. Logged by the router; not surfaced as a degradation.
    }
  }
  hits = hits.slice(0, topK);

  const { kept, dropped } = autocut(hits);
  if (dropped > 0) {
    // One structured line, matching defaultLogSink's shape. Counts only — no query text and no
    // content (D28). Unconditional rather than debug-gated: a control that quietly shrinks the
    // evidence behind an answer has to leave a trace, or "the model did not know that" and "we did
    // not give it that" become the same observation.
    console.log(JSON.stringify({
      level: 'info',
      kind: 'retrieval_autocut',
      workspace: ctx.workspaceId,
      returned: kept.length,
      dropped,
      ratio: AUTOCUT_RATIO,
    }));
  }
  return { hits: kept, degraded };
}

/** The parameters the one statement below is built from. Named, because the diagnostic script has to
 *  be able to construct exactly what a real search constructs. */
export interface HybridQueryParams {
  /** The user's question, verbatim. Feeds `plainto_tsquery` for the AND tier. */
  query: string;
  /** The OR-joined term list from `keywordQueryText` (question + any expansions). */
  orQuery: string;
  /** The query embedding as a pgvector literal, or null when the embedder was unavailable. */
  vectorLiteral: string | null;
  hasVector: boolean;
  fetchK: number;
  /** Metadata filters (migration 0014), null when not given. Ordinary correctness predicates, not
   *  security ones — deleted_at is NOT among them; that stays enforced purely by RLS (see 0014's
   *  header for why duplicating it here would be the wrong move, per D66). */
  since: string | null;
  until: string | null;
  author: string | null;
}

/**
 * The since/until/author predicate (migration 0014) — ONE definition, interpolated into every arm
 * that scans `content_chunks` directly (kw_pool, vec, title), rather than the three independent
 * copies an adversarial review of the M6 PR found. All three arms reference the filtered columns
 * via the same `c` alias, so there is no aliasing reason for the duplication to have existed.
 *
 * Not deleted_at, which stays enforced purely by RLS (see 0014's header for why duplicating THAT
 * one here would be the wrong move, per D66) — this fragment carries only the ordinary, non-security
 * correctness filters.
 *
 * Returns a postgres.js fragment, not a query result: like `hybridQuery` itself, this is built and
 * interpolated via `${...}` into a larger statement, never awaited on its own.
 */
function metadataFilter(
  tx: postgres.TransactionSql,
  since: string | null,
  until: string | null,
  author: string | null,
) {
  return tx`
    and (${since}::date is null or c.effective_date >= ${since}::date)
    and (${until}::date is null or c.effective_date <= ${until}::date)
    and (${author}::text is null or lower(trim(c.author)) = lower(trim(${author}::text)))`;
}

/**
 * The retrieval statement, as a postgres.js FRAGMENT rather than an inline template.
 *
 * ONE statement, not four. MEASURED (D65): the cost here is per-STATEMENT — every round trip on
 * this link is ~110ms, and the ::vector cast of a 1536-element literal is a second one by itself.
 * Promise.all over the arms buys nothing, because a transaction holds one connection and
 * postgres.js runs its statements in order on it.
 *
 * WHY IT IS A FUNCTION: `scripts/explain-search.ts` interpolates it into `explain (analyze, buffers)
 * ${...}`, so the plan that script prints is the plan the shipped query produces — not the plan of a
 * copy that was accurate on the day it was pasted. A copy is exactly how idx_pages_title_prefix
 * shipped dead (0011): the query and the thing that claimed to describe it drifted, and nothing
 * errored. Returning the fragment from one place removes the second copy entirely.
 *
 * THE PARAMETER IS NAMED `tx` ON PURPOSE, and renaming it is not cosmetic. `postgres.TransactionSql`
 * is the real guarantee — the only way to obtain one is `.begin()`, and withScopedTx is the only
 * caller that opens one here — but test/scoped-tx-guard.test.ts classifies a content query by
 * walking back to the template opener and reading the HANDLE NAME. Calling it `sql` makes every
 * content-table line in this statement read as unscoped, and the guard fails, correctly by its own
 * rule. The name and the type must agree.
 */
export function hybridQuery(
  tx: postgres.TransactionSql,
  p: HybridQueryParams,
): postgres.PendingQuery<FusedRow[]> {
  const { query, orQuery, vectorLiteral, hasVector, fetchK, since, until, author } = p;
  return tx<FusedRow[]>`
    with
    -- ── KEYWORD ARM ────────────────────────────────────────────────────────
    -- Two tiers over ONE scan. The OR query decides membership (so the arm is non-empty), and the
    -- AND query decides ORDER — a chunk containing every term of the question sorts above one that
    -- merely shares a word.
    --
    -- Tier ordering alone does NOT fix the flooding, and this is measured rather than argued: on the
    -- A17 corpus the AND tier is EMPTY for 8 of 10 eval questions, so for those the boolean is false
    -- on every row and changes nothing, while the OR arm matches 8-14 of 14 chunks. "ts_rank_cd" has
    -- no IDF, so those tail rows enter fusion weighted identically to a real vector hit.
    --
    -- The control is the SLOT SPLIT below, not a relevance floor. A floor was measured and REJECTED:
    -- relevant chunks bottom out at ts_rank_cd 0.1, which is also the 10th percentile of ALL matched
    -- rows, so every threshold that removes noise also removes true positives. Recorded rather than
    -- shipped as a no-op constant.
    --
    -- c.content_tsv is the STORED generated column from migration 0013, not to_tsvector(...). It
    -- holds exactly what that expression computes, so the arm matches and ranks an identical set —
    -- but it is computed at write time rather than three times per visible chunk per question.
    -- MEASURED: this CTE was 3,712ms of a 3,812ms statement on a 2,829-chunk workspace, because the
    -- planner never chose the expression index and applied the match as a filter over the whole
    -- workspace. Reverting these three references to to_tsvector('english', c.content) restores that
    -- cost silently — the results would be identical and only the clock would say so.
    kw_pool as (
      select c.id,
             c.page_id,
             (c.content_tsv @@ plainto_tsquery('english', ${query})) as and_tier,
             ts_rank_cd(c.content_tsv, websearch_to_tsquery('english', ${orQuery})) as rank
      from content_chunks c
      where ${orQuery} <> ''
        and c.content_tsv @@ websearch_to_tsquery('english', ${orQuery})
        -- Metadata filters (migration 0014). Ordinary correctness predicates, identical shape in
        -- every arm — NOT deleted_at, which stays enforced purely by RLS (see the module header).
        ${metadataFilter(tx, since, until, author)}
    ),
    kw_split as (
      -- Ranked WITHIN each tier, which is what lets the two leave as separate arms below. Each list
      -- then starts at rank 1 independently, so an AND-tier match contributes W_KW_AND/(k+0) while
      -- the best OR-only match contributes W_KW_OR/(k+0) — the evidence gap expressed in the score
      -- rather than in a rank offset that RRF barely notices.
      select id, page_id, and_tier, rank,
             row_number() over (partition by and_tier order by rank desc, id) as tier_rk
      from kw_pool
    ),
    kw_and as (
      -- CAPPED, like every other arm. This was the one unbounded arm, and the justification for
      -- leaving it open ("the AND tier is empty for 8 of 10 eval questions") is a property of LONG
      -- questions: for a one- or two-word ask, plainto_tsquery and websearch_to_tsquery match the
      -- SAME set, so and_tier is true on every matched chunk and the entire keyword match set flows
      -- into fusion — defeating ARM_LIMIT, KW_OR_SLOTS and TITLE_LIMIT at once. Ranks are already
      -- dense from 1 within the tier, so the cut leaves no gaps in the RRF denominator.
      select id, page_id, tier_rk as rk from kw_split where and_tier and tier_rk <= ${KW_AND_SLOTS}
    ),
    kw_or as (
      -- The slot split: only the strongest OR-only rows enter fusion at all. Ranks are already dense
      -- from 1 within the tier, so the cut leaves no gaps — and rk is an RRF denominator, where a
      -- gap silently deflates every score below it.
      select id, page_id, tier_rk as rk from kw_split where not and_tier and tier_rk <= ${KW_OR_SLOTS}
    ),

    -- ── VECTOR ARM ─────────────────────────────────────────────────────────
    -- The inner ORDER BY is DISTANCE ALONE, with no tie-break, and that is load-bearing rather than
    -- an oversight: pathkeys match all-or-nothing, so "order by dist, id" stops matching the HNSW
    -- index's ordering operator and drops the plan to a sequential scan plus a full sort over every
    -- chunk in the workspace.
    --
    -- Determinism is restored on the OUTSIDE, where it is free: the window re-sorts the 20 surviving
    -- rows by a distance already computed, and ", id" there breaks exact ties (which duplicate
    -- content produces) without touching the index path.
    vec as (
      select id, page_id, dist, row_number() over (order by dist, id) as rk
      from (
        -- "embedding is not null" is explicit, not incidental. The column is nullable by design
        -- (deferred embedding stays possible — migration 0004), and NULLs sort last only because
        -- NULLS LAST is the ASC default: a property of the sort direction, not a claim about
        -- relevance. Without this, a freshly-ingested workspace feeds fusion rows the vector arm has
        -- expressed no opinion about.
        select c.id, c.page_id, c.embedding <=> ${vectorLiteral}::vector as dist
        from content_chunks c
        where ${hasVector}::boolean
          and c.embedding is not null
          ${metadataFilter(tx, since, until, author)}
        order by c.embedding <=> ${vectorLiteral}::vector
        limit ${ARM_LIMIT}
      ) v
    ),

    -- ── TITLE ARM ──────────────────────────────────────────────────────────
    -- Emits CHUNK ids, and that is the entire trick. A pages-based arm emits PAGE ids, which meet
    -- the other arms at "group by id" and then hit "join content_chunks on c.id = f.id" — a join a
    -- page id never satisfies. Every title hit would consume a result slot and return nothing, on
    -- every ask, silently.
    --
    -- Capped to ord = 0 rather than projected onto all of a page's chunks: fanning one title match
    -- across forty chunks is precisely the flooding the slot split above exists to prevent.
    title as (
      select id, page_id, row_number() over (order by rank desc, id) as rk
      from (
        select c.id, c.page_id,
               ts_rank_cd(to_tsvector('english', coalesce(p.title, '')), websearch_to_tsquery('english', ${orQuery})) as rank
        from pages p
        join content_chunks c on c.page_id = p.id and c.ord = 0
        where ${orQuery} <> ''
          and to_tsvector('english', coalesce(p.title, '')) @@ websearch_to_tsquery('english', ${orQuery})
          ${metadataFilter(tx, since, until, author)}
        -- ORDER BY belongs INSIDE the limit. Without it the LIMIT took an arbitrary 10 matching
        -- titles (physical order, on a seq scan) and the outer row_number() then ranked whatever
        -- happened to survive — so the rk values feeding RRF were not the title arm's best 10.
        order by rank desc, c.id
        limit ${TITLE_LIMIT}
      ) t
    ),

    -- ── WEIGHTED RRF ───────────────────────────────────────────────────────
    -- Must match rrfFuse exactly; test/hybrid.test.ts asserts it on real data and rrfFuse stays the
    -- specification (D65). Two traps live here: rrfFuse ranks from ZERO ("1/(k + rank)") while
    -- row_number() starts at ONE, hence "rk - 1"; and RRF ties are common, so both sides break them
    -- on id.
    --
    -- ::float8, not numeric: this expression computes numeric in Postgres and float64 in TypeScript,
    -- and the two round differently at the tie boundary — which is the boundary the equivalence test
    -- lives on.
    --
    -- page_id is carried through EVERY arm and grouped on, so the per-page cap below has something
    -- to partition by without a second join.
    fused as (
      select id, page_id, sum(weight / (${RRF_K} + rk - 1))::float8 as score
      from (
        select id, page_id, rk, ${W_KW_AND}::float8 as weight from kw_and
        union all
        select id, page_id, rk, ${W_KW_OR}::float8 from kw_or
        union all
        select id, page_id, rk, ${W_VEC}::float8 from vec
        union all
        select id, page_id, rk, ${W_TITLE}::float8 from title
      ) u
      group by id, page_id
    ),
    -- A THIRD level, because a window result cannot be filtered at the level that computes it.
    capped as (
      select id, page_id, score,
             row_number() over (partition by page_id order by score desc, id) as page_rk
      from fused
    ),
    -- A SHORTLIST, bounded, before anything expensive touches these rows.
    --
    -- This is the reconciliation of two correct-but-opposing constraints. The joins below must
    -- happen before the final LIMIT (a row they discard must be SKIPPED, not counted — see the note
    -- there). But "before the limit" was being read as "unbounded", and the candidates CTE detoasts
    -- the full chunk text and computes a 1536-dimension cosine for EVERY row it receives. Fusion has
    -- already decided relative order by this point, so taking a generous shortlist changes no result
    -- that could have survived while turning a corpus-sized join into a fixed-size one.
    shortlist as (
      select id, page_id, score
      from capped
      where page_rk <= ${MAX_PER_PAGE}
      order by score desc, id
      limit ${Math.max(fetchK * 4, 100)}
    ),
    -- ── FINAL CANDIDATES ───────────────────────────────────────────────────
    -- The joins happen HERE, before the final limit. That limit used to sit inside the fusion CTE,
    -- where a row these joins discard had ALREADY consumed one of the topK slots — so a chunk whose
    -- page is not visible (drift; test/leak-canary.test.ts proves that state is representable)
    -- silently cost a result rather than being skipped.
    --
    -- LATERAL + an "offset 0" fence, not plain inner joins. This is a MEASURED plan fix, and the ugly token is
    -- load-bearing — read this before tidying it away.
    --
    -- Written as "from shortlist f join content_chunks c on c.id = f.id join pages p on …", the
    -- planner is free to choose its join order and chose the worst one available: it built
    -- pages ⋈ content_chunks FIRST — every chunk of the whole workspace, 2,829 rows, re-probing
    -- idx_chunks_acl once per page — and only then matched that against the shortlist with a
    -- Join Filter, discarding 96,152 of 96,186 rows. 232ms to produce 34.
    --
    -- It does that because it cannot estimate this CTE chain: every node from kw_pool down to
    -- shortlist is estimated at 1-13 rows, so "join the two big tables first, then filter" looks
    -- free. That estimate will not improve on its own — "acl && (SELECT current_grants())" is
    -- estimated at 59 rows where the truth is 2,829, because the value is an InitPlan the planner
    -- cannot see, and its correlation with the workspace_id predicate is total (aclForScope stamps
    -- ws:<workspace_id>, so the two predicates select the SAME rows while the planner multiplies
    -- their selectivities as though they were independent). Every plan in this statement that goes
    -- wrong goes wrong for that one reason.
    --
    -- LATERAL ALONE DOES NOT FIX IT, and that was measured too rather than assumed: Postgres pulls a
    -- simple lateral subquery up into an ordinary join, restoring the same freedom and the same
    -- 367ms plan. "offset 0" is the documented optimisation fence that blocks the pull-up — a no-op
    -- semantically (offset 0 rows), which is precisely why it is safe, and it is the reason the
    -- LATERAL survives to mean what it says. With the fence the shortlist is necessarily the outer
    -- relation and each of its (at most 100) rows is one primary-key lookup:
    --
    --   before  Nested Loop … Rows Removed by Join Filter: 96152      232ms
    --   after   Index Scan using content_chunks_pkey … loops=34       0.3ms   (+ Memoize on pages)
    --
    -- Same rows out, same order out. The work in is now bounded by a constant this file sets rather
    -- than by how large the tenant grew.
    candidates as (
      select f.id as chunk_id, c.page_id, p.slug, p.title, c.ord, c.content, c.locator, p.scope,
             f.score as rrf,
             -- Cosine SIMILARITY (1 - distance), so bigger is better on both terms of the blend.
             -- coalesce because a chunk reached through the keyword or title arm may have no
             -- embedding at all; NULL here would poison the whole blended score and sort the row
             -- unpredictably rather than last.
             coalesce(1 - (c.embedding <=> ${vectorLiteral}::vector), 0) as cos_sim
      from shortlist f
      -- CROSS JOIN LATERAL, not LEFT JOIN LATERAL: a subquery returning no rows must DROP the
      -- candidate, which is exactly what the inner joins above did. A left join would keep the row
      -- with null slug/scope and hand the caller a citation to a page it may not read.
      cross join lateral (
        select cc.page_id, cc.ord, cc.content, cc.locator, cc.embedding
        from content_chunks cc where cc.id = f.id offset 0
      ) c
      cross join lateral (
        select pp.slug, pp.title, pp.scope
        from pages pp where pp.id = c.page_id offset 0
      ) p
    ),
    -- ── EXACT-DUPLICATE COLLAPSE ───────────────────────────────────────────
    -- Byte-identical chunk text can legitimately appear on several pages: a boilerplate clause, a
    -- repeated sheet header, the same paragraph pasted into two notes. Retrieving all of them spends
    -- prompt slots on text the model has already read, and makes an answer look corroborated by
    -- several sources when it has one.
    --
    -- Keyed on md5(content) rather than on chunk id: the point is that the TEXT is the same, and the
    -- rows are by definition different chunks on different pages. The survivor is the best-scoring
    -- one, so the citation points at the copy retrieval actually ranked.
    --
    -- Deliberately NOT adjacent-locator collapse, which the plan also lists: merging neighbouring
    -- chunks changes what a citation POINTS AT, and the per-page cap above already bounds the
    -- redundancy to MAX_PER_PAGE. That belongs in its own change, with the citation contract in view.
    deduped as (
      select *, row_number() over (partition by md5(content) order by rrf desc, chunk_id) as dup_rk
      from candidates
    )
    -- ── COSINE RE-SCORE BLEND ──────────────────────────────────────────────
    -- RRF deliberately throws away magnitude: it sees only rank, so a vector hit at distance 0.05
    -- and one at 0.45 contribute identically if they landed at the same position. That is what makes
    -- RRF robust across arms with incomparable scales, and it is also what makes it blunt at the top
    -- of a short list. This blend puts the magnitude back for the FINAL ordering only.
    --
    -- The RRF term is normalised by the best score in this candidate set, because RRF scores have no
    -- absolute scale — an unnormalised sum of ~1/60 terms would be swamped by a cosine similarity of
    -- ~0.8 and the blend would silently become a pure vector sort.
    select chunk_id, page_id, slug, title, ord, content, locator, scope,
           (${BLEND_RRF} * (rrf / nullif(max(rrf) over (), 0)) + ${BLEND_COS} * cos_sim)::float8 as score
    from deduped
    where dup_rk = 1
    order by score desc, chunk_id
    limit ${fetchK}`;
}
