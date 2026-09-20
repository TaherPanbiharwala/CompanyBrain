// Live DB test for hybrid search. embed() is mocked (fake-ai helper, deterministic per-string
// vectors) so keyword-arm and vector-arm behavior are each independently verifiable without real
// API cost — retrieval QUALITY against a real corpus is validated by `bun run eval:a17`.
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { liveOrFail, hasDbEnv } from './helpers/live.ts';
import { adminSql, closePools } from '../src/db/client.ts';
import { buildContext, resolveGrants } from '../src/core/context.ts';
import { importPage } from '../src/ingest/import.ts';
import { hybridSearch, keywordQueryText } from '../src/search/hybrid.ts';
import { rrfFusePerList } from '../src/search/rrf.ts';
import {
  BASELINE_RETRIEVAL_KNOBS,
  GBRAIN_RETRIEVAL_KNOBS,
  effectiveIntentWeights,
  retrievalKnobHash,
} from '../src/search/retrieval-knobs.ts';
import { classifyQueryIntent } from '../src/search/query-intent.ts';
import { toVectorLiteral } from '../src/ai/vector.ts';
import { embed, withRouterScope } from '../src/ai/router.ts';
import { withScopedTx } from '../src/db/client.ts';
import { config } from '../src/config.ts';
import { installFakeAiFetch } from './helpers/fake-ai.ts';

// Per-run unique addresses: email_normalized is UNIQUE, and cleanup only runs in afterAll,
// so a crashed run would otherwise poison every future run's setup.
const RUN = crypto.randomUUID().slice(0, 8);

const live = liveOrFail('hybrid', hasDbEnv());
const mutableConfig = config as unknown as Record<string, unknown>;
const MAX_PER_PAGE = BASELINE_RETRIEVAL_KNOBS.candidatePool.maxPerPage;

describe.skipIf(!live)('hybridSearch — live', () => {
  let ws1 = '';
  let ws2 = '';
  let p1 = '';
  let p2 = '';
  const realFetch = globalThis.fetch;
  const realKey = mutableConfig.OPENAI_API_KEY;
  const EXACT_SENTENCE = 'The zebra migration route crosses the northern salt flats every spring.';
  // Every page beforeAll ingests into ws1. Kept beside the fixture so an added page updates both.
  const WS1_SLUGS = ['keyword-doc', 'filler-doc', 'exact-doc', 'long-doc', 'title-only-doc'];

  // Long enough to chunk into more than MAX_PER_PAGE pieces (chunkText targets 300 words), with the
  // distinctive term in EVERY chunk — so the per-page cap is what limits its share of the results,
  // not a shortage of matching chunks. Without a fixture like this the cap ships unobserved.
  const LONG_BODY = Array.from(
    { length: 40 },
    (_, i) => `Section ${i}: the catamaran hull survey records displacement, beam and draft for berth ${i}. ` +
      'Each entry repeats the same measurement vocabulary so the section reads as continuous prose rather than a list.',
  ).join(' ');

  beforeAll(async () => {
    mutableConfig.OPENAI_API_KEY = 'test-key';
    globalThis.fetch = installFakeAiFetch();

    const admin = adminSql();
    p1 = (await admin<{ id: string }[]>`insert into principals (email, email_normalized) values (${`hybrid-a-${RUN}@ex.com`}, ${`hybrid-a-${RUN}@ex.com`}) returning id`)[0]!.id;
    p2 = (await admin<{ id: string }[]>`insert into principals (email, email_normalized) values (${`hybrid-b-${RUN}@ex.com`}, ${`hybrid-b-${RUN}@ex.com`}) returning id`)[0]!.id;
    ws1 = (await admin<{ id: string }[]>`insert into workspaces (name, created_by) values (${'hybrid-ws1'}, ${p1}) returning id`)[0]!.id;
    ws2 = (await admin<{ id: string }[]>`insert into workspaces (name, created_by) values (${'hybrid-ws2'}, ${p2}) returning id`)[0]!.id;
    await admin`insert into workspace_members (workspace_id, principal_id, role) values (${ws1}, ${p1}, 'owner'), (${ws2}, ${p2}, 'owner')`;

    const ctx1 = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });
    await importPage(ctx1, { slug: 'keyword-doc', title: 'Keyword doc', body: 'This document mentions zzzqqqmarker exactly once, nowhere else.' });
    await importPage(ctx1, { slug: 'filler-doc', title: 'Filler doc', body: 'Totally unrelated filler content about baking bread.' });
    await importPage(ctx1, { slug: 'exact-doc', title: 'Exact doc', body: EXACT_SENTENCE });
    await importPage(ctx1, { slug: 'long-doc', title: 'Long doc', body: LONG_BODY });
    // The title arm's fixture: "thermodynamics" appears in the TITLE and nowhere in any body, so a
    // hit on it cannot have come from the keyword or vector arms.
    await importPage(ctx1, {
      slug: 'title-only-doc',
      title: 'Thermodynamics reference',
      body: 'This page discusses heat exchange in industrial settings without ever naming the field.',
    });
  }, { timeout: 40000 }); // 5 importPage calls, each several round trips to the remote DB

  afterAll(async () => {
    globalThis.fetch = realFetch;
    mutableConfig.OPENAI_API_KEY = realKey;
    const admin = adminSql();
    await admin`delete from workspaces where id in (${ws1}, ${ws2})`;
    await admin`delete from principals where id in (${p1}, ${p2})`;
    await closePools({ timeout: 5 });
  });

  it('keyword arm surfaces a document via a distinctive token', async () => {
    const ctx = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });
    const { hits } = await hybridSearch(ctx, 'zzzqqqmarker');
    expect(hits.some((h) => h.slug === 'keyword-doc')).toBe(true);
  });

  it('vector arm ranks an exact-content match first (identical text -> identical fake embedding)', async () => {
    const ctx = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });
    const { hits } = await hybridSearch(ctx, EXACT_SENTENCE);
    expect(hits[0]?.slug).toBe('exact-doc');
  });

  it('a query with no keyword match still returns hits (the vector arm ranks all rows)', async () => {
    const ctx = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });
    const { hits } = await hybridSearch(ctx, 'qwertyuiopasdfghjklzxcvbnm-no-such-token');
    // The title's claim is "the vector arm ranks ALL rows", so the observable consequence is that a
    // zero-keyword-match query is still ANSWERABLE. `Array.isArray(hits)` was the old assertion, and
    // it holds for `[]` — i.e. it passes in exactly the world where the claim is false.
    expect(hits.length).toBeGreaterThan(0);
    // ...and every hit came from THIS workspace's pages, not from a globally-nearest neighbour.
    // The list must be ALL THREE pages beforeAll ingests into ws1: an earlier version of this
    // assertion omitted `filler-doc`, so it would have failed a perfectly correct implementation —
    // the vector arm has no relevance cutoff, and filler-doc is exactly the low-relevance row this
    // test's own premise says must still be ranked and returned.
    for (const h of hits) expect(WS1_SLUGS).toContain(h.slug);
  });

  it('the SQL fusion agrees with rrfFuseWeighted, which stays the specification', async () => {
    // hybridSearch fuses inside the query to save a round trip (D65). That is only safe if the SQL
    // arithmetic matches the reference implementation EXACTLY, and there are three traps in it:
    // rrfFuseWeighted ranks from zero while row_number() starts at one; RRF ties are common so both
    // sides must break them on id; and the arm WEIGHTS must line up positionally with the union
    // order in the SQL. This runs each arm as its own query, fuses in TypeScript, applies the same
    // per-page cap, and fails the moment the two drift.
    //
    // The arms are reproduced from the SQL, not re-derived — the thing under test is the FUSION, not
    // the arm definitions. The weights come from hybrid.ts itself so the two cannot diverge silently.
    const ctx = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });
    const query = 'news about zebra salt flats zzzqqqmarker bread';
    const orQuery = keywordQueryText(query);

    const { hits: viaSql } = await hybridSearch(ctx, query, { knobs: GBRAIN_RETRIEVAL_KNOBS });

    const [qv] = await withRouterScope({ workspaceId: ws1, zdr: false }, () => embed([query]));
    const lit = toVectorLiteral(qv!);
    const { kwAnd, kwOr, vec, title } = await withScopedTx(ctx, async (tx) => {
      const kwTiers = await tx<{ id: string; page_id: string; and_tier: boolean; tier_rk: number }[]>`
        select id, page_id, and_tier, tier_rk from (
          select c.id, c.page_id,
                 (to_tsvector('english', c.content) @@ plainto_tsquery('english', ${query})) as and_tier,
                 ts_rank_cd(to_tsvector('english', c.content), websearch_to_tsquery('english', ${orQuery})) as rank,
                 row_number() over (
                   partition by (to_tsvector('english', c.content) @@ plainto_tsquery('english', ${query}))
                   order by ts_rank_cd(to_tsvector('english', c.content), websearch_to_tsquery('english', ${orQuery})) desc, c.id
                 ) as tier_rk
          from content_chunks c
          where to_tsvector('english', c.content) @@ websearch_to_tsquery('english', ${orQuery})
        ) t
        where and_tier or tier_rk <= 10
        order by and_tier desc, tier_rk`;
      // The two tiers leave as SEPARATE ranked lists, each dense from 1 — that separation is the
      // thing under test, since it is what lets them carry different weights.
      const kwAnd = kwTiers.filter((r) => r.and_tier);
      const kwOr = kwTiers.filter((r) => !r.and_tier);
      const vec = await tx<{ id: string; page_id: string }[]>`
        select id, page_id from (
          select c.id, c.page_id, c.embedding <=> ${lit}::vector as dist
          from content_chunks c
          where c.embedding is not null
          order by c.embedding <=> ${lit}::vector
          limit 20
        ) v
        order by dist, id`;
      const title = await tx<{ id: string; page_id: string }[]>`
        select id, page_id from (
          select c.id, c.page_id,
                 ts_rank_cd(to_tsvector('english', coalesce(p.title, '')), websearch_to_tsquery('english', ${orQuery})) as rank
          from pages p
          join content_chunks c on c.page_id = p.id and c.ord = 0
          where to_tsvector('english', coalesce(p.title, '')) @@ websearch_to_tsquery('english', ${orQuery})
          limit 10
        ) t
        order by rank desc, id`;
      return { kwAnd, kwOr, vec, title };
    });

    // Positional against the union order in hybridSearch: kw_and, kw_or, vec, title. A transposed
    // weight vector is invisible here — both sides would be equally wrong — so this line is read,
    // not asserted.
    const policy = GBRAIN_RETRIEVAL_KNOBS;
    const intentWeights = effectiveIntentWeights(policy, classifyQueryIntent(query));
    const keywordK = policy.fusion.rrfK / intentWeights.keywordWeight;
    const vectorK = policy.fusion.rrfK / intentWeights.vectorWeight;
    const fused = rrfFusePerList([
      { ids: kwAnd.map((r) => r.id), weight: policy.fusion.keywordAndWeight, k: keywordK },
      { ids: kwOr.map((r) => r.id), weight: policy.fusion.keywordOrWeight, k: keywordK },
      { ids: vec.map((r) => r.id), weight: policy.fusion.vectorWeight, k: vectorK },
      { ids: title.map((r) => r.id), weight: policy.fusion.titleWeight, k: keywordK },
    ]);

    const pageOf = new Map<string, string>();
    for (const r of [...kwAnd, ...kwOr, ...vec, ...title]) pageOf.set(r.id, r.page_id);
    const perPage = new Map<string, number>();
    const capped = fused.filter((r) => {
      const pid = pageOf.get(r.id)!;
      const n = perPage.get(pid) ?? 0;
      if (n >= MAX_PER_PAGE) return false;
      perPage.set(pid, n + 1);
      return true;
    });

    // The final ordering is a BLEND, not the fused order — RRF decides the candidate set, cosine
    // similarity refines how the shortlist is sorted. Reproducing it here is what keeps this a
    // specification check rather than a check of two thirds of the pipeline.
    // The SQL collapses byte-identical chunk text before scoring, keeping the best-scoring copy.
    const maxRrf = Math.max(...capped.map((r) => r.score));
    const cos = new Map<string, number>();
    const cosRows = await withScopedTx(ctx, (tx) => tx<{ id: string; cos_sim: number }[]>`
      select c.id, coalesce(1 - (c.embedding <=> ${lit}::vector), 0)::float8 as cos_sim
      from content_chunks c
      where c.id = any(${capped.map((r) => r.id)}::uuid[])`);
    for (const r of cosRows) cos.set(r.id, r.cos_sim);
    const scored = capped.map((r) => ({
      id: r.id,
      score: r.score,
      blended: policy.fusion.rrfBlend * (r.score / maxRrf) +
        policy.fusion.cosineBlend * (cos.get(r.id) ?? 0),
    }));
    const bestByContent = new Map<string, { id: string; score: number; blended: number }>();
    const contentRows = await withScopedTx(ctx, (tx) => tx<{ id: string; h: string }[]>`
      select c.id, md5(c.content) as h from content_chunks c
      where c.id = any(${capped.map((r) => r.id)}::uuid[])`);
    const hashOf = new Map(contentRows.map((r) => [r.id, r.h]));
    for (const r of scored) {
      const h = hashOf.get(r.id)!;
      const cur = bestByContent.get(h);
      if (!cur || r.blended > cur.blended || (r.blended === cur.blended && r.id < cur.id)) bestByContent.set(h, r);
    }
    const survivors = scored.filter((r) => bestByContent.get(hashOf.get(r.id)!)!.id === r.id);

    // Normalised by the best RRF score in the candidate set, exactly as the SQL's
    // `max(rrf) over ()` does — an unnormalised RRF sum of ~1/60 terms would be swamped by a
    // cosine of ~0.8 and the blend would quietly become a pure vector sort.
    const viaTs = survivors
      .map((r) => ({ id: r.id, blended: r.blended }))
      .sort((a, b) => b.blended - a.blended || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, 8)
      .map((r) => r.id);

    expect(viaSql.length).toBeGreaterThan(0); // a vacuous [] === [] would prove nothing
    expect(viaSql.map((h) => h.chunkId)).toEqual(viaTs);
  }, 30_000);

  it('the keyword arm returns rows for a query whose terms are spread across chunks', async () => {
    // The measured defect this whole arm rewrite exists for: plainto_tsquery ANDs every lexeme, so a
    // question whose words are spread over several documents matched NOTHING — zero rows for 7 of 10
    // A17 eval questions. The hybrid was a vector search wearing a hybrid's name.
    const ctx = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });
    const orQuery = keywordQueryText('zzzqqqmarker bread zebra');

    const [and_, or_] = await withScopedTx(ctx, async (tx) => {
      const a = await tx<{ n: number }[]>`
        select count(*)::int as n from content_chunks c
        where to_tsvector('english', c.content) @@ plainto_tsquery('english', ${'zzzqqqmarker bread zebra'})`;
      const o = await tx<{ n: number }[]>`
        select count(*)::int as n from content_chunks c
        where to_tsvector('english', c.content) @@ websearch_to_tsquery('english', ${orQuery})`;
      return [a[0]!.n, o[0]!.n];
    });

    // No document contains all three words, so the AND form finds nothing…
    expect(and_, 'the AND premise no longer holds — this fixture stopped demonstrating the defect').toBe(0);
    // …while the OR form finds the three documents that each contain one.
    expect(or_).toBeGreaterThanOrEqual(3);
  }, 30_000);

  it('caps how many chunks one page may take, so a long document cannot own the results', async () => {
    // Without a fixture whose page has more chunks than MAX_PER_PAGE this control ships unobserved.
    const ctx = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });
    const { hits } = await hybridSearch(ctx, 'catamaran');
    const fromLong = hits.filter((h) => h.slug === 'long-doc');
    expect(fromLong.length, 'the long document took more than its share of the result set').toBeLessThanOrEqual(MAX_PER_PAGE);
    // Positive control: it must be present at all, or the cap is not what limited it.
    expect(fromLong.length).toBeGreaterThan(0);
  }, 30_000);

  it('a title match surfaces a page whose BODY never mentions the term', async () => {
    // The title arm's whole reason to exist, and the shape of its trap: it must emit CHUNK ids. A
    // pages-based arm emits page ids, which never satisfy `join content_chunks on c.id = f.id` — so
    // every title hit would consume a slot and return nothing, on every ask, silently.
    const ctx = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });
    const { hits } = await hybridSearch(ctx, 'thermodynamics');
    expect(hits.some((h) => h.slug === 'title-only-doc'), 'the title arm returned nothing usable').toBe(true);
  }, 30_000);

  it('every hit carries a score and a locator field', async () => {
    // The `search` op's contract depends on both, and `score` was discarded entirely before M3.
    const ctx = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });
    const { hits } = await hybridSearch(ctx, EXACT_SENTENCE);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(typeof h.score, 'score must be a number — ::float8, not numeric-as-string').toBe('number');
      expect(h.score).toBeGreaterThan(0);
      expect(h).toHaveProperty('locator'); // null for pasted text, but present
    }
    // Descending, and strictly ordered — the caller ranks on this.
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
  }, 30_000);

  it('explicit baseline policy reproduces the selected default exactly', async () => {
    const ctx = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });
    const implicit = await hybridSearch(ctx, 'zzzqqqmarker bread');
    const explicit = await hybridSearch(ctx, 'zzzqqqmarker bread', { knobs: BASELINE_RETRIEVAL_KNOBS });
    expect(explicit.hits.map((hit) => [hit.chunkId, hit.score])).toEqual(
      implicit.hits.map((hit) => [hit.chunkId, hit.score]),
    );
    expect(explicit.diagnostics).toEqual({
      intent: 'general',
      recencyMode: 'off',
      knobHash: retrievalKnobHash(BASELINE_RETRIEVAL_KNOBS),
    });
  }, 30_000);

  it('applies exact-match and recency factors inside SQL before final ordering', async () => {
    const ctx = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });
    const baseline = await hybridSearch(ctx, 'keyword doc', { knobs: BASELINE_RETRIEVAL_KNOBS });
    const baselineHit = baseline.hits.find((hit) => hit.slug === 'keyword-doc');
    expect(baselineHit).toBeDefined();

    const exact = await hybridSearch(ctx, 'keyword doc', {
      knobs: { intent: { enabled: true, weights: { general: { exactMatchBoost: 2 } } } },
    });
    expect(exact.hits.find((hit) => hit.slug === 'keyword-doc')!.score).toBeCloseTo(baselineHit!.score * 2, 10);

    const today = new Date().toISOString().slice(0, 10);
    const recent = await hybridSearch(ctx, 'keyword doc', {
      knobs: { recency: { mode: 'on', halflifeDays: 90, coefficient: 0.3 } },
      recencyAsOf: today,
    });
    expect(recent.hits.find((hit) => hit.slug === 'keyword-doc')!.score).toBeCloseTo(baselineHit!.score * 1.3, 10);
    expect(recent.diagnostics.recencyMode).toBe('on');
  }, 30_000);

  it('rejects an unbound evaluation clock before retrieval starts', async () => {
    const ctx = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });
    await expect(hybridSearch(ctx, 'keyword doc', { recencyAsOf: 'yesterday' }))
      .rejects.toThrow('recencyAsOf must be a valid ISO date');
  });

  it('falls back to keyword-only when the embedder is down, and SAYS so', async () => {
    // The failure this guards is not an outage — it is an outage that looks like a normal result.
    // Keyword-only retrieval is faster, returns a plausible list, and logs `ok`, so an embedding
    // provider being down would show up only as answers quietly getting worse.
    const ctx = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });
    const working = installFakeAiFetch();
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/embeddings')) return new Response('provider down', { status: 503 });
      return working(input as never, init as never);
    }) as unknown as typeof fetch;

    try {
      const { hits, degraded } = await hybridSearch(ctx, 'zzzqqqmarker');
      expect(degraded, 'an embedding outage was not reported').toBe('keyword_only');
      // …and it still answered. A degradation that returns nothing is just an outage with extra steps.
      expect(hits.some((h) => h.slug === 'keyword-doc'), 'keyword-only retrieval found nothing').toBe(true);
      // Every score must still be finite and ordered: with the vector arm gated off, cos_sim
      // coalesces to 0 and the blend collapses to pure RRF. A NULL leaking through here would sort
      // unpredictably rather than last.
      for (const h of hits) expect(Number.isFinite(h.score)).toBe(true);
      for (let i = 1; i < hits.length; i++) expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    } finally {
      globalThis.fetch = working;
    }
  }, 60_000);

  it('reports no degradation on the happy path — the flag is not always-on', async () => {
    const ctx = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });
    const { degraded } = await hybridSearch(ctx, 'zzzqqqmarker');
    expect(degraded).toBeUndefined();
  }, 30_000);

  it('since/until filter on effective_date narrows results (migration 0014)', async () => {
    // A distinctive token shared by both docs, so the KEYWORD arm reliably surfaces both regardless
    // of the fake embedder's uncorrelated vectors — same mechanism the "keyword arm surfaces a
    // document" test above relies on. The filter, not the retrieval, is what's under test.
    const ctx = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });
    const TOKEN = 'zzzqqqDateFilterMarker';
    await importPage(ctx, {
      slug: `date-old-${RUN}`,
      title: 'Old dated doc',
      body: `This document mentions ${TOKEN} and is explicitly dated in the past.`,
      effectiveDate: '2020-01-01',
    });
    await importPage(ctx, {
      slug: `date-new-${RUN}`,
      title: 'Undated doc',
      body: `This document also mentions ${TOKEN}, with no explicit date — defaults to today.`,
    });

    const unfiltered = (await hybridSearch(ctx, TOKEN)).hits.map((h) => h.slug);
    expect(unfiltered).toContain(`date-old-${RUN}`);
    expect(unfiltered).toContain(`date-new-${RUN}`);

    const sinceRecent = (await hybridSearch(ctx, TOKEN, { since: '2024-01-01' })).hits.map((h) => h.slug);
    expect(sinceRecent).toContain(`date-new-${RUN}`);
    expect(sinceRecent, 'since excluded nothing — the filter is a no-op').not.toContain(`date-old-${RUN}`);

    const untilOld = (await hybridSearch(ctx, TOKEN, { until: '2020-12-31' })).hits.map((h) => h.slug);
    expect(untilOld).toContain(`date-old-${RUN}`);
    expect(untilOld, 'until excluded nothing — the filter is a no-op').not.toContain(`date-new-${RUN}`);
  }, 30_000);

  it('author filter narrows results, case- and whitespace-insensitively (migration 0014)', async () => {
    const ctx = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });
    const TOKEN = 'zzzqqqAuthorFilterMarker';
    await importPage(ctx, {
      slug: `auth-a-${RUN}`,
      title: 'Authored',
      body: `This document mentions ${TOKEN} and names its author.`,
      author: 'zzzqqq-author-a',
    });
    await importPage(ctx, {
      slug: `auth-none-${RUN}`,
      title: 'No author given',
      body: `This document also mentions ${TOKEN}, with no author.`,
    });

    const filtered = (await hybridSearch(ctx, TOKEN, { author: 'zzzqqq-author-a' })).hits.map((h) => h.slug);
    expect(filtered).toContain(`auth-a-${RUN}`);
    expect(filtered, 'author excluded nothing — the filter is a no-op').not.toContain(`auth-none-${RUN}`);

    // An adversarial review found the filter was raw `=` with no case/whitespace folding — a stored
    // author of 'zzzqqq-author-a' would not have matched a query of '  ZZZQQQ-Author-A  ' before the
    // fix. The op boundary (src/api/operations.ts) trims on the way IN; this proves the SQL comparison
    // itself (src/search/hybrid.ts) also folds case, independent of what the caller already cleaned up
    // — direct callers of hybridSearch (this test included) bypass that zod layer entirely.
    const differentCase = (await hybridSearch(ctx, TOKEN, { author: '  ZZZQQQ-Author-A  ' })).hits.map((h) => h.slug);
    expect(differentCase, 'a differently-cased/padded author query matched nothing').toContain(`auth-a-${RUN}`);
  }, 30_000);

  it('uses adjusted score to select the survivor of byte-identical chunks', async () => {
    const ctx = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });
    const body = `duplicate-shared-${RUN} evidence is byte-identical on both pages.`;
    await importPage(ctx, { slug: 'duplicate-winner', title: 'Neutral A', body });
    await importPage(ctx, { slug: 'duplicate-loser', title: 'Neutral B', body });
    const { hits } = await hybridSearch(ctx, 'duplicate winner', {
      knobs: { intent: { enabled: true, weights: { general: { exactMatchBoost: 4 } } } },
    });
    expect(hits.some((hit) => hit.slug === 'duplicate-winner')).toBe(true);
    expect(hits.some((hit) => hit.slug === 'duplicate-loser')).toBe(false);
  }, 30_000);

  it('rescales every admitted candidate beyond the old 100-row shortlist boundary', async () => {
    const ctx = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });
    const admin = adminSql();
    // rls-exempt: synthetic fixture writes only, stamped into this test's disposable workspace and
    // removed by the workspace cascade in afterAll. Search itself still runs through withScopedTx.
    await admin`
      with generated as (
        select n,
               case when n < 100 then ${`vector-bulk-${RUN}-`} || n::text
                    when n = 100 then 'bulk-marker'
                    else ${`keyword-bulk-${RUN}-`} || n::text end as slug
        from generate_series(0, 199) n
      ), inserted as (
        insert into pages (workspace_id, slug, title, owner_principal, scope, acl, body, effective_date)
        select ${ws1}::uuid, slug, 'Neutral bulk fixture', ${p1}, 'workspace', ${[`ws:${ws1}`]}::text[],
               case when n < 100 then repeat('bulk marker ', 20) || 'strong lexical fixture'
                    when n = 100 then 'bulk token fixture'
                    else repeat('bulk ', 20) || 'token fixture' end,
               current_date
        from generated
        returning id, slug, acl
      )
      insert into content_chunks (workspace_id, page_id, acl, ord, content, embedding, effective_date)
      select ${ws1}::uuid, p.id, p.acl, 0,
             case when p.slug like ${`vector-bulk-${RUN}-%`}
                    then repeat('bulk marker ', 20) || 'strong lexical fixture ' || p.slug
                  when p.slug = 'bulk-marker' then 'bulk token unique-target'
                  else repeat('bulk ', 20) || 'token fixture ' || p.slug end,
             null::vector,
             current_date
      from inserted p`;

    const withoutExact = await hybridSearch(ctx, 'bulk marker', {
      topK: 8,
      knobs: {
        candidatePool: { vectorLimit: 0, keywordAndLimit: 100, keywordOrLimit: 100, titleLimit: 0, maxPerPage: 1 },
        fusion: { keywordAndWeight: 3, keywordOrWeight: 1, rrfK: 1000 },
      },
    });
    expect(withoutExact.hits.some((hit) => hit.slug === 'bulk-marker')).toBe(false);

    const promoted = await hybridSearch(ctx, 'bulk marker', {
      topK: 8,
      knobs: {
        candidatePool: { vectorLimit: 0, keywordAndLimit: 100, keywordOrLimit: 100, titleLimit: 0, maxPerPage: 1 },
        fusion: { keywordAndWeight: 3, keywordOrWeight: 1, rrfK: 1000 },
        intent: { enabled: true, weights: { general: { exactMatchBoost: 4 } } },
      },
    });
    expect(promoted.hits[0]?.slug).toBe('bulk-marker');
  }, 40_000);

  it('reserves graph capacity when the four base arms use their full 400-row policy budget', async () => {
    const ctx = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });
    const admin = adminSql();
    const targetSlug = `graph-shortlist-target-${RUN}`;
    const seedPrefix = `graph-shortlist-seed-${RUN}-`;
    const acl = [`ws:${ws1}`];

    // rls-exempt: compact synthetic fixture write into this test's disposable workspace. The
    // search under test still runs through hybridSearch -> withScopedTx as cb_app.
    await admin`
      with inserted as (
        insert into pages (workspace_id, slug, title, owner_principal, scope, acl, body, effective_date)
        select ${ws1}::uuid,
               ${seedPrefix} || n::text,
               'Graph shortlist seed ' || n::text,
               ${p1}, 'workspace', ${acl}::text[],
               ${targetSlug} || ' appears here as seed evidence ' || n::text,
               current_date
        from generate_series(1, 5) n
        union all
        select ${ws1}::uuid, ${targetSlug}, 'Neutral adjacency node', ${p1}, 'workspace',
               ${acl}::text[], 'Only unrelated adjacency payload lives in this body.', current_date
        returning id, slug, acl, body
      ), inserted_chunks as (
        insert into content_chunks (workspace_id, page_id, acl, ord, content, embedding, effective_date)
        select ${ws1}::uuid, id, acl, 0, body, null::vector, current_date
        from inserted
        returning page_id
      )
      insert into links (
        workspace_id, from_page_id, to_page_id, from_acl, to_acl,
        link_kind, link_source, context, created_at
      )
      select ${ws1}::uuid, seed.id, target.id, seed.acl, target.acl,
             'mention', seed.slug, 'shortlist graph fixture', now()
      from inserted seed
      cross join inserted target
      where seed.slug like ${seedPrefix + '%'} and target.slug = ${targetSlug}`;

    const policy = {
      candidatePool: {
        vectorLimit: 100,
        keywordAndLimit: 100,
        keywordOrLimit: 100,
        titleLimit: 100,
        maxPerPage: 1,
      },
      // The configured base arms total the maximum 400 even though this compact fixture does not
      // fill every slot. The target is graph-only: its body/title do not match. Exact matching
      // applies after the shortlist, where its slug should promote it above the stronger seed-arm
      // candidates. This proves the separate graph reservation is non-zero at the boundary and
      // that every graph row admitted into fusion survives through the scoring stage.
      intent: { enabled: true, weights: { general: { exactMatchBoost: 4 } } },
    } as const;

    const withoutGraph = await hybridSearch(ctx, targetSlug, { topK: 1, knobs: policy });
    expect(withoutGraph.hits.some((hit) => hit.slug === targetSlug)).toBe(false);

    const withGraph = await hybridSearch(ctx, targetSlug, {
      topK: 1,
      knobs: {
        ...policy,
        graphExpansion: { enabled: true, maxNeighborsPerSeed: 1, weight: 1 },
      },
    });
    expect(withGraph.hits[0]?.slug).toBe(targetSlug);
  }, 30_000);

  it('deduplicates reciprocal edges before the per-seed graph cap', async () => {
    const ctx = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });
    const admin = adminSql();
    const token = `graph-reciprocal-${RUN}`;
    const seedSlug = `graph-cap-seed-${RUN}`;
    const aSlug = `graph-cap-a-${RUN}`;
    const bSlug = `graph-cap-b-${RUN}`;
    const cSlug = `graph-cap-c-${RUN}`;
    const acl = [`ws:${ws1}`];

    // rls-exempt: compact synthetic graph fixture in this test's disposable workspace. The
    // reciprocal rows intentionally model two physical edges for the same undirected neighbor.
    await admin`
      with fixture(slug, title, body) as (values
        (${seedSlug}::text, 'Graph cap seed', ${token + ' is the only searchable seed evidence'}::text),
        (${aSlug}::text, 'Graph cap neighbor A', 'Unique adjacency payload alpha'::text),
        (${bSlug}::text, 'Graph cap neighbor B', 'Unique adjacency payload bravo'::text),
        (${cSlug}::text, 'Graph cap neighbor C', 'Unique adjacency payload charlie'::text)
      ), inserted as (
        insert into pages (workspace_id, slug, title, owner_principal, scope, acl, body, effective_date)
        select ${ws1}::uuid, slug, title, ${p1}, 'workspace', ${acl}::text[], body, current_date
        from fixture
        returning id, slug, acl, body
      ), inserted_chunks as (
        insert into content_chunks (workspace_id, page_id, acl, ord, content, embedding, effective_date)
        select ${ws1}::uuid, id, acl, 0, body, null::vector, current_date
        from inserted
        returning page_id
      ), edge_specs(from_slug, to_slug, source, edge_created_at) as (values
        (${seedSlug}::text, ${aSlug}::text, 'forward-a'::text, '2026-01-01T00:00:00Z'::timestamptz),
        (${aSlug}::text, ${seedSlug}::text, 'reverse-a'::text, '2026-01-02T00:00:00Z'::timestamptz),
        (${seedSlug}::text, ${bSlug}::text, 'forward-b'::text, '2026-02-01T00:00:00Z'::timestamptz),
        (${seedSlug}::text, ${cSlug}::text, 'forward-c'::text, '2026-03-01T00:00:00Z'::timestamptz)
      )
      insert into links (
        workspace_id, from_page_id, to_page_id, from_acl, to_acl,
        link_kind, link_source, context, created_at
      )
      select ${ws1}::uuid, from_page.id, to_page.id, from_page.acl, to_page.acl,
             'mention', edge_specs.source, 'reciprocal graph fixture', edge_specs.edge_created_at
      from edge_specs
      join inserted from_page on from_page.slug = edge_specs.from_slug
      join inserted to_page on to_page.slug = edge_specs.to_slug`;

    const { hits } = await hybridSearch(ctx, token, {
      topK: 4,
      knobs: {
        candidatePool: {
          vectorLimit: 0,
          keywordAndLimit: 1,
          keywordOrLimit: 0,
          titleLimit: 0,
          maxPerPage: 1,
        },
        graphExpansion: { enabled: true, maxNeighborsPerSeed: 2 },
      },
    });
    const slugs = hits.map((hit) => hit.slug);
    expect(slugs).toContain(seedSlug);
    expect(slugs).toContain(aSlug);
    expect(slugs).toContain(bSlug);
    expect(slugs, 'the third unique neighbor exceeded maxNeighborsPerSeed=2').not.toContain(cSlug);
  }, 30_000);

  it('workspace isolation: a second, empty workspace sees none of the first workspace\'s content', async () => {
    const ctx2 = buildContext({ principal: p2, workspaceId: ws2, role: 'owner', grants: resolveGrants(p2, ws2), remote: false });
    const { hits } = await hybridSearch(ctx2, 'zzzqqqmarker');
    expect(hits).toHaveLength(0);
  });
});
