// The three scale properties the leak canary deliberately does NOT carry.
//
// test/leak-canary.test.ts:5-9 names this file and says why it exists: filtered-HNSW recall at corpus
// scale, GUC-bleed concurrency and pool headroom are slow and timing-dependent, and welding the
// flakiest tests in the suite to the one file that must never be disabled is how a sacred file gets
// disabled. It had never actually been written — docs/plan.md:341-343 lists all three as
// "MISSING → add" and M4's gate ("an unfiltered query leaks nothing and doctor is green") was resting
// on their absence.
//
// Gated on CB_RUN_PERF_TESTS, NOT CB_REQUIRE_LIVE_TESTS (D93). See perfOrFail in test/helpers/live.ts.
//
// What each property is for, since none of them can be seen by a serial ladder:
//   A. RLS post-filtering silently truncates one tenant's vector arm when another tenant is large.
//      Invisible with one tenant, which is why A17 shipped clean (D58).
//   B. A tx-local GUC leaking across a pooled connection would hand one principal's keyring to the
//      next request. This is the failure the whole withScopedTx design exists to prevent.
//   C. A transaction held across a model call exhausts the pool under concurrency (D6).
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { perfOrFail, hasDbEnv } from './helpers/live.ts';
import { fakeEmbedVector, installFakeAiFetch } from './helpers/fake-ai.ts';
import { adminSql, appSql, withScopedTx, closePools } from '../src/db/client.ts';
import { buildContext, resolveGrants, type OperationContext } from '../src/core/context.ts';
import { toVectorLiteral } from '../src/ai/vector.ts';
import { hybridSearch, keywordQueryText } from '../src/search/hybrid.ts';
import { BASELINE_RETRIEVAL_KNOBS } from '../src/search/retrieval-knobs.ts';
import { answerQuestion } from '../src/answer/answer.ts';
import { config } from '../src/config.ts';

const RUN = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
const live = perfOrFail('perf-recall', hasDbEnv());
const mutableConfig = config as unknown as Record<string, unknown>;

// One nonsense term, >= MIN_TERM_CHARS (3) so keywordQueryText keeps it, and present in NO content or
// title anywhere. That makes the keyword and title arms provably empty (A1) so a full top-k can only
// have come from the vector arm.
const QUERY = `xyzzyquark${RUN}`;

// 5x pgvector's default hnsw.ef_search, MEASURED at 40 on this server. The margin absorbs HNSW's
// approximation: with iterative_scan off, the index hands back at most ef_search globally-nearest
// candidates and RLS filters them AFTERWARDS, so the small tenant's arm collapses.
const NOISE_CHUNKS = 200;
// FOUR pages, not one. MAX_PER_PAGE caps a single page at 3 hits (src/search/hybrid.ts:65) while
// DEFAULT_TOP_K is 8, so a one-page small tenant could never return a full top-k and the test would
// fail for a reason that has nothing to do with recall.
const SMALL_PAGES = 4;
const SMALL_CHUNKS_PER_PAGE = 4;
const TOP_K = 8;
const MAX_PER_PAGE = BASELINE_RETRIEVAL_KNOBS.candidatePool.maxPerPage;

/** Close to the query vector: the noisy tenant crowds out everyone else's candidates. */
function nearVector(i: number): number[] {
  const qv = fakeEmbedVector(QUERY);
  const jitter = fakeEmbedVector(`perf-jitter-${i}`);
  return qv.map((v, j) => v + 0.02 * jitter[j]!);
}
/** Far from the query vector: the small tenant's own chunks, which it must still get back. */
const farVector = (j: number): number[] => fakeEmbedVector(`perf-far-${j}`);

describe.skipIf(!live)('perf/scale — the three properties gated apart from the canary', () => {
  let wsBig = '';
  let wsSmall = '';
  let pBig = '';
  let pSmall = '';
  let smallPageIds: string[] = [];

  const realFetch = globalThis.fetch;
  const realOpenAI = mutableConfig.OPENAI_API_KEY;
  const realOpenRouter = mutableConfig.OPENROUTER_API_KEY;
  const realChatModel = mutableConfig.CHAT_MODEL;
  const realPoolMax = config.DB_POOL_MAX;

  const ctxFor = (principal: string, workspaceId: string): OperationContext =>
    buildContext({ principal, workspaceId, role: 'owner', grants: resolveGrants(principal, workspaceId), remote: false });

  const ctxBig = () => ctxFor(pBig, wsBig);
  const ctxSmall = () => ctxFor(pSmall, wsSmall);

  beforeAll(async () => {
    mutableConfig.OPENAI_API_KEY = 'test-key';
    mutableConfig.OPENROUTER_API_KEY = 'test-key';
    if (!realChatModel) mutableConfig.CHAT_MODEL = 'openrouter:deepseek/deepseek-v4-flash';
    // Deterministic embeddings, so the fixture's stored vectors and the query vector come from the
    // same function. Without this the router 401s, hybridSearch degrades to keyword_only, and A4
    // measures the arm it is NOT about.
    globalThis.fetch = installFakeAiFetch(() => '{"answer":"stub","citations":[]}');

    const admin = adminSql();
    // Left over from a crashed prior run: dropped at BOTH ends so this suite self-heals.
    await admin`drop schema if exists cb_perf cascade`;

    const mkPrincipal = async (tag: string) =>
      (
        await admin<{ id: string }[]>`
          insert into principals (email, email_normalized)
          values (${`perf-${tag}-${RUN}@ex.com`}, ${`perf-${tag}-${RUN}@ex.com`}) returning id`
      )[0]!.id;
    pBig = await mkPrincipal('big');
    pSmall = await mkPrincipal('small');

    const mkWorkspace = async (name: string, owner: string) =>
      (await admin<{ id: string }[]>`insert into workspaces (name, created_by) values (${name}, ${owner}) returning id`)[0]!.id;
    wsBig = await mkWorkspace(`perf-big-${RUN}`, pBig);
    wsSmall = await mkWorkspace(`perf-small-${RUN}`, pSmall);

    await admin`
      insert into workspace_members (workspace_id, principal_id, role) values
        (${wsBig}, ${pBig}, 'owner'), (${wsSmall}, ${pSmall}, 'owner')`;

    // Seeded through adminSql, not importPage: 200+ chunks of ingest waist is minutes of round trips
    // and this file tests scale, not ingestion. `acl`/`scope`/`owner_principal` are stamped to match
    // aclForScope's invariant exactly, so doctor's scope/acl agreement check stays green on the
    // fixture while it exists.
    const mkPage = async (ws: string, owner: string, slug: string, title: string) =>
      (
        await admin<{ id: string }[]>`
          insert into pages (workspace_id, slug, title, owner_principal, scope, acl)
          values (${ws}, ${slug}, ${title}, ${owner}, 'workspace', ${[`ws:${ws.toLowerCase()}`]})
          returning id`
      )[0]!.id;

    const bigPageId = await mkPage(wsBig, pBig, `perf-noise-${RUN}`, 'Noisy tenant corpus');
    const bigAcl = [`ws:${wsBig.toLowerCase()}`];
    const bigRows = Array.from({ length: NOISE_CHUNKS }, (_, i) => ({
      workspace_id: wsBig,
      page_id: bigPageId,
      acl: bigAcl,
      ord: i,
      // Deliberately does NOT contain QUERY: this tenant must win on VECTOR proximity alone, or the
      // truncation being demonstrated could be keyword crowding instead.
      content: `filler paragraph ${i} lorem ipsum dolor sit amet consectetur`,
      embedding: toVectorLiteral(nearVector(i)),
      token_count: 12,
    }));
    // 25 rows/statement: a 1536-element literal is ~15 KB, so the whole set in one statement would be
    // a ~3 MB query string.
    for (let i = 0; i < bigRows.length; i += 25) {
      const batch = bigRows.slice(i, i + 25);
      await admin`insert into content_chunks ${admin(batch, 'workspace_id', 'page_id', 'acl', 'ord', 'content', 'embedding', 'token_count')}`;
    }

    const smallAcl = [`ws:${wsSmall.toLowerCase()}`];
    smallPageIds = [];
    for (let p = 0; p < SMALL_PAGES; p++) {
      const id = await mkPage(wsSmall, pSmall, `perf-small-${RUN}-${p}`, `Small tenant note ${p}`);
      smallPageIds.push(id);
      const rows = Array.from({ length: SMALL_CHUNKS_PER_PAGE }, (_, k) => ({
        workspace_id: wsSmall,
        page_id: id,
        acl: smallAcl,
        ord: k,
        content: `small tenant note ${p} section ${k} consectetur adipiscing elit sed do`,
        embedding: toVectorLiteral(farVector(p * SMALL_CHUNKS_PER_PAGE + k)),
        token_count: 12,
      }));
      await admin`insert into content_chunks ${admin(rows, 'workspace_id', 'page_id', 'acl', 'ord', 'content', 'embedding', 'token_count')}`;
    }

    // A2 asserts a specific PLANNER CHOICE, and the planner chooses on statistics. Freshly-inserted
    // rows carry none until autovacuum gets to them, so without this the plan measured depends on
    // whether an ANALYZE happened to land between the seed and the query — which would make A2 flap
    // red for a reason that has nothing to do with the property, in the one suite whose own comments
    // admit it is the timing-dependent one.
    await admin`analyze content_chunks`;
    await admin`analyze pages`;
  }, 600_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    mutableConfig.OPENAI_API_KEY = realOpenAI;
    mutableConfig.OPENROUTER_API_KEY = realOpenRouter;
    mutableConfig.CHAT_MODEL = realChatModel;

    // RESTORE FIRST, assert second. bun test shares ONE process across files
    // (src/db/client.ts:157), so a DB_POOL_MAX left at 1 or 2 gives every later suite a starved pool
    // and produces cascading timeouts that look like unrelated failures. The first version only
    // ASSERTED the restore here while the actual restores lived in the nested afterAll hooks — so if a
    // nested beforeAll threw after mutating it, this fired and then left the pool starved anyway.
    // Detect-and-leave is worse than repair-and-report.
    const leaked = config.DB_POOL_MAX;
    mutableConfig.DB_POOL_MAX = realPoolMax;

    const admin = adminSql();
    // Each statement guarded on its own, and each independently: ids are '' until seeding gets that
    // far, and `where id in ('','')` raises 22P02, which would abort the REST of this hook — masking
    // whatever made beforeAll fail and leaking the principals it did manage to create.
    const swallow = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
      try { await fn(); } catch (err) { console.error(`[perf-recall cleanup] ${label} failed:`, err); }
    };
    await swallow('drop cb_perf', () => admin`drop schema if exists cb_perf cascade`);
    const wsIds = [wsBig, wsSmall].filter(Boolean);
    const pIds = [pBig, pSmall].filter(Boolean);
    // cascades pages + chunks + members
    if (wsIds.length) await swallow('delete workspaces', () => admin`delete from workspaces where id in ${admin(wsIds)}`);
    if (pIds.length) await swallow('delete principals', () => admin`delete from principals where id in ${admin(pIds)}`);
    // Real self-healing: a run killed before afterAll leaves rows behind, and RUN is regenerated each
    // time so nothing else would ever reclaim them.
    await swallow('sweep stale perf principals', () => admin`
      delete from principals where email_normalized like 'perf-%@ex.com' and created_at < now() - interval '1 day'`);
    await swallow('close pools', () => closePools({ timeout: 5 }));

    expect(leaked, 'DB_POOL_MAX leaked out of the perf suite (restored now, but a nested afterAll was skipped)')
      .toBe(realPoolMax);
  }, 300_000);

  // ── A. Filtered-HNSW recall at corpus scale (D58) ────────────────────────
  //
  // The canary already asserts that hnsw.iterative_scan is a REAL GUC set to relaxed_order
  // (leak-canary.test.ts:320-340). That proves the setting exists, not that it has the effect the
  // comment in src/db/client.ts:201-208 claims. These four tests prove the effect.
  describe('filtered-HNSW recall at corpus scale (D58)', () => {
    it('A1 control: the keyword and title arms are EMPTY for this query', async () => {
      // Without this, a full top-k below could be keyword recall and would say nothing about the
      // vector arm — the arm this whole property is about.
      const orQuery = keywordQueryText(QUERY);
      expect(orQuery, 'the query term was filtered out by keywordQueryText').not.toBe('');

      const [kw, title] = await withScopedTx(ctxSmall(), async (tx) => [
        (
          await tx<{ n: number }[]>`
            select count(*)::int as n from content_chunks c
            where to_tsvector('english', c.content) @@ websearch_to_tsquery('english', ${orQuery})`
        )[0]!.n,
        (
          await tx<{ n: number }[]>`
            select count(*)::int as n from pages p
            where to_tsvector('english', coalesce(p.title, '')) @@ websearch_to_tsquery('english', ${orQuery})`
        )[0]!.n,
      ]);
      expect(kw, 'the keyword arm matches this query — pick a term absent from all content').toBe(0);
      expect(title, 'the title arm matches this query — pick a term absent from all titles').toBe(0);
    }, 120_000);

    it('A2: at this corpus size the planner picks an EXACT tenant index, not HNSW', async () => {
      // MEASURED, and it is the reason A3/A4 below have to force the plan.
      //
      //   Limit -> Sort(dist) -> tenant-bounded index scan
      //
      // The HNSW index is never touched. `current_grants()` is wrapped in `(SELECT …)`, which makes it
      // an InitPlan, and an InitPlan output is a valid index-qual RHS. Before migration 0015 the
      // chosen path was idx_chunks_acl; after D106/0019 the workspace-leading
      // idx_chunks_ws_effdate may be cheaper even with no date bound. Both are exact tenant scans
      // followed by a sort, which is the property this control needs: it keeps the planner OUT of
      // the post-filter regime hnsw.iterative_scan exists to fix, so D58's hazard is latent at this
      // scale rather than absent (a production corpus, where the tenant's share is small in absolute
      // terms too, is where the planner crosses over).
      const lit = toVectorLiteral(fakeEmbedVector(QUERY));
      const plan = await withScopedTx(ctxSmall(), async (tx) => {
        // EXPLAIN's output column is literally named "QUERY PLAN" and cannot be aliased, so it is
        // read by that key rather than a convenient one.
        const rows = await tx<Record<string, unknown>[]>`
          explain (format json)
          select c.id from content_chunks c
          where c.embedding is not null
          order by c.embedding <=> ${lit}::vector
          limit 20`;
        return JSON.stringify(rows[0]!['QUERY PLAN']);
      });
      expect(
        plan.includes('idx_chunks_acl') || plan.includes('idx_chunks_ws_effdate'),
        `expected an exact tenant index plan; got: ${plan}`,
      ).toBe(true);
      expect(plan).not.toContain('idx_chunks_embedding');
    }, 120_000);

    // A3 and A4 are one experiment in two halves: SAME corpus, SAME forced plan, and the ONLY
    // difference between them is hnsw.iterative_scan. That is what makes this a measurement of the
    // GUC rather than of the planner.
    //
    // Forcing is honest here, stated rather than hidden, and `enable_sort` is the RIGHT lever rather
    // than a convenient one. MEASURED across five GUC combinations: turning off seq and bitmap scans
    // does NOT force it (the planner just switches to a plain Index Scan on idx_chunks_ws plus a
    // Sort, still exact, still 16 rows). What forces it is removing Sort — because the entire value
    // of an HNSW scan is that it returns rows ALREADY ORDERED, so a planner that may not sort must
    // use the index that supplies the ordering natively. That is precisely the regime a
    // production-scale corpus reaches on its own, where sorting the tenant's share is no longer the
    // cheap option. A2 above pins what the planner does when left alone.
    const forcedHnswCount = async (iterativeScan: 'off' | 'relaxed_order'): Promise<string[]> => {
      const lit = toVectorLiteral(fakeEmbedVector(QUERY));
      return withScopedTx(ctxSmall(), async (tx) => {
        // A second set_config in the same transaction overrides the value withScopedTx set, so the
        // mechanism is testable without touching src/db/client.ts.
        await tx`select set_config('hnsw.iterative_scan', ${iterativeScan}, true),
                        set_config('enable_sort', 'off', true)`;
        const plan = JSON.stringify(
          (
            await tx<Record<string, unknown>[]>`
              explain (format json)
              select c.id from content_chunks c
              where c.embedding is not null
              order by c.embedding <=> ${lit}::vector
              limit 20`
          )[0]!['QUERY PLAN'],
        );
        // The control for both halves. If the forcing stopped working, both halves would silently
        // measure the exact plan and both would report full recall — the GUC's effect would look
        // like it had been proven when it had never been exercised.
        expect(plan, `the HNSW plan was NOT forced; got: ${plan}`).toContain('idx_chunks_embedding');
        return (
          await tx<{ id: string }[]>`
            select c.id from content_chunks c
            where c.embedding is not null
            order by c.embedding <=> ${lit}::vector
            limit 20`
        ).map((r) => r.id);
      });
    };

    it('A3 mechanism: on the HNSW path with iterative_scan OFF, the small tenant is STARVED', async () => {
      // MEASURED: this returns ZERO. Not "fewer results" — the small tenant's vector arm goes
      // completely dark, because every one of the first ef_search (40) candidates belongs to the
      // noisy tenant and RLS filters them AFTER the index has already stopped looking. An `ask` in
      // this state answers from the keyword arm alone and nothing anywhere reports a degradation.
      const rows = await forcedHnswCount('off');
      expect(
        rows.length,
        `the vector arm returned ${rows.length} of 20 rows on the forced HNSW path with ` +
          `iterative_scan=off, where it should be starved: the noisy tenant owns ${NOISE_CHUNKS} ` +
          `chunks nearer the query than anything this tenant holds. If this is not truncating, raise ` +
          `NOISE_CHUNKS well above 5x hnsw.ef_search, or check whether ef_search has been raised on ` +
          `this server — without truncation here, A4 proves nothing.`,
      ).toBeLessThan(TOP_K);
    }, 120_000);

    it('A4 property: the SAME forced plan with relaxed_order recovers full recall', async () => {
      // The pair to A3. One GUC apart, and the whole of D58 is in the difference.
      const rows = await forcedHnswCount('relaxed_order');
      expect(
        rows.length,
        `relaxed_order recovered only ${rows.length} rows where iterative_scan=off truncates. The ` +
          `small tenant holds ${SMALL_PAGES * SMALL_CHUNKS_PER_PAGE} chunks, so the iterative scan ` +
          `should keep going until it has them all.`,
      ).toBe(SMALL_PAGES * SMALL_CHUNKS_PER_PAGE);
    }, 120_000);

    it('A5 property: hybridSearch returns a FULL top-k for the small tenant', async () => {
      // The production path, through withScopedTx's real relaxed_order — so this tests the wiring
      // rather than a re-implementation of it.
      const { hits, degraded } = await hybridSearch(ctxSmall(), QUERY);
      expect(degraded, 'the embedder degraded, so this measured keyword-only retrieval').toBeUndefined();
      expect(
        hits.length,
        `the small tenant got ${hits.length} of ${TOP_K} hits. A3 proves the corpus can truncate it, ` +
          `so this is the tenancy effect D58 describes: one large tenant degrading another's recall.`,
      ).toBe(TOP_K);

      const allowed = new Set(smallPageIds);
      expect(hits.every((h) => allowed.has(h.pageId)), 'a hit came from outside the small tenant').toBe(true);
      expect(hits.some((h) => h.content.includes('filler paragraph')), 'noisy-tenant content leaked into results').toBe(false);

      // MAX_PER_PAGE is why the fixture needs four pages; assert the reason holds rather than leaving
      // it in a comment.
      for (const id of new Set(hits.map((h) => h.pageId))) {
        expect(hits.filter((h) => h.pageId === id).length).toBeLessThanOrEqual(MAX_PER_PAGE);
      }
    }, 120_000);
  });

  // ── B. GUC bleed across a pooled connection ─────────────────────────────
  //
  // The failure the whole withScopedTx design exists to prevent, and one a serial ladder cannot see:
  // every existing suite runs one tenant at a time on a 10-connection pool, so a GUC that survived a
  // commit would simply never be observed. max=1 forces every transaction onto the same client
  // connection, which is the condition under which a leak becomes visible.
  describe('GUC bleed across a pooled connection (DB_POOL_MAX=1)', () => {
    beforeAll(async () => {
      mutableConfig.DB_POOL_MAX = 1;
      await closePools({ timeout: 5 }); // the next appSql() builds a max=1 pool
    }, 60_000);

    afterAll(async () => {
      mutableConfig.DB_POOL_MAX = realPoolMax;
      await closePools({ timeout: 5 });
    }, 60_000);

    it('B1: two tenants interleaved on one connection each see only their own keyring', async () => {
      const tenants = [
        { ctx: ctxBig(), ws: wsBig, principal: pBig },
        { ctx: ctxSmall(), ws: wsSmall, principal: pSmall },
      ];
      // Eight alternating transactions, all in flight at once against a single connection, so they
      // queue onto the same backend one after another — exactly the reuse pattern a pooler produces.
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => {
          const t = tenants[i % 2]!;
          return withScopedTx(t.ctx, async (tx) => {
            const [g] = await tx<{ ws: string; principal: string; grants: string[]; pid: number }[]>`
              select current_setting('app.workspace', true) as ws,
                     current_setting('app.principal', true) as principal,
                     public.current_grants()                as grants,
                     pg_backend_pid()                       as pid`;
            const rows = await tx<{ workspace_id: string }[]>`select workspace_id from pages`;
            return { expected: t, seen: g!, rows };
          });
        }),
      );

      for (const { expected, seen, rows } of results) {
        expect(seen.ws, 'a transaction read another tenant\'s app.workspace').toBe(expected.ws);
        expect(seen.principal).toBe(expected.principal);
        expect(seen.grants.slice().sort()).toEqual(resolveGrants(expected.principal, expected.ws).slice().sort());
        // Positive control: without rows of its own, "saw nothing of the other tenant" is trivially
        // true and the assertion below proves nothing.
        expect(rows.length, 'this tenant sees none of its OWN pages — the negative below is vacuous').toBeGreaterThan(0);
        expect(rows.every((r) => r.workspace_id === expected.ws)).toBe(true);
      }

      // The strong form of the claim, asserted only where it can hold. Through Supabase's transaction
      // pooler a CLIENT-side max=1 does not pin one SERVER backend — Supavisor assigns per
      // transaction — so making this unconditional would be a flaky red rather than a real property.
      // A conditional ASSERTION opens no hole; a conditional SKIP would.
      if (!config.isPooler) {
        const pids = new Set(results.map((r) => r.seen.pid));
        expect(pids.size, `expected one backend on a max=1 pool, saw ${[...pids].join(', ')}`).toBe(1);
      }
    }, 180_000);

    it('B2: the GUCs do not survive the commit — an unscoped read stays fail-closed', async () => {
      // test/leak-canary.test.ts:258-261 already asserts the no-transaction case, but on a max=10
      // pool it may land on a connection that never carried GUCs at all. On max=1, immediately after
      // B1, it provably lands on the one that did — which is the difference between "this connection
      // happens to be clean" and "the GUCs were released".
      //
      // If this ever fails spuriously, the cause is almost certainly a SESSION-level app.workspace
      // left on a pooled server backend by something else — which is what breaking client.ts's
      // `set_config(…, true)` to `false` does, and the poisoned backend survives restoring the code
      // until the pooler cycles it. That is the hazard, not a flake in the test.
      for (let i = 0; i < 5; i++) {
        const [g] = await appSql()<{ ws: string }[]>`
          select coalesce(nullif(current_setting('app.workspace', true), ''), '(unset)') as ws`;
        expect(g!.ws, 'app.workspace survived a commit on a reused connection').toBe('(unset)');
        expect((await appSql()`select id from pages`).length, 'an unscoped read returned rows').toBe(0);
      }
    }, 120_000);

    it('B3: a cached generic plan does not freeze one principal\'s keyring', async () => {
      // 0007:36-39, doctor.ts:229-231 and CONTEXT.md §2 all assert ONE causal chain: an IMMUTABLE
      // zero-argument function is constant-folded at PLAN time, so a cached generic plan would bake in
      // one principal's grants and hand them to the next request; STABLE forbids that. Nothing had
      // ever tested it, and the claim is incomplete — see the assertions below.
      //
      // cb_perf.frozen_grants() is a deliberately-broken clone: IMMUTABLE, and plpgsql so it cannot be
      // inlined, which forces the planner's evaluate_function path to execute it at plan time. It is
      // the DETECTOR — without proving the fold happens for a function shaped that way, "the real one
      // did not freeze" is a claim about a defect that may not exist on this server.
      //
      // It lives in its own schema on purpose, and that is load-bearing rather than tidy: every doctor
      // snapshot filters schema 'public' (and 'cb_internal' for definers), so a scratch function in
      // public would move expected-grants/expected-policies, turn doctor red, and invite a reflexive
      // `doctor --update` that rubber-stamps the drift.
      const admin = adminSql();
      const stmt = `p_${RUN}`;
      await admin.unsafe(`
        create schema if not exists cb_perf;
        grant usage on schema cb_perf to cb_app;
        create or replace function cb_perf.frozen_grants() returns text[]
          language plpgsql immutable set search_path = pg_catalog
          as $fn$ begin return string_to_array(nullif(current_setting('app.grants', true), ''), ','); end $fn$;
        grant execute on function cb_perf.frozen_grants() to cb_app;`);

      const bigGrants = resolveGrants(pBig, wsBig);
      const smallGrants = resolveGrants(pSmall, wsSmall);

      try {
      const out = await withScopedTx(ctxBig(), async (tx) => {
        try {
          // force_generic_plan removes the five-execution heuristic, so the plan built on the first
          // EXECUTE is the plan reused on the second.
          await tx.unsafe(`set local plan_cache_mode = 'force_generic_plan'`);
          await tx.unsafe(
            `prepare ${stmt} as select cb_perf.frozen_grants() as folded, ` +
              // The WRAPPED form, matching how the policy actually calls it. MEASURED: this freezes
              // too, so the `(SELECT …)` wrapper is NOT a second barrier — see assertion 2b.
              `(select cb_perf.frozen_grants()) as folded_wrapped, ` +
              `public.current_grants() as live, (select public.current_grants()) as live_wrapped, ` +
              `(select count(*)::int from pages) as n`,
          );
          type Row = { folded: string[]; folded_wrapped: string[]; live: string[]; live_wrapped: string[]; n: number };
          const first = (await tx.unsafe(`execute ${stmt}`)) as unknown as Row[];
          // Switch identity WITHIN the transaction: the plan is already cached, the GUCs now say
          // someone else. This is the pooled-connection reuse the whole design is about, compressed
          // into one transaction so PREPARE and EXECUTE provably hit the same backend through the
          // transaction pooler.
          await tx`select set_config('app.workspace', ${wsSmall}, true),
                          set_config('app.grants', ${smallGrants.join(',')}, true)`;
          const second = (await tx.unsafe(`execute ${stmt}`)) as unknown as Row[];
          const stats = (await tx.unsafe(
            `select generic_plans, custom_plans from pg_prepared_statements where name = '${stmt}'`,
          )) as unknown as { generic_plans: number; custom_plans: number }[];
          return { first: first[0]!, second: second[0]!, stats: stats[0]! };
        } finally {
          await tx.unsafe(`deallocate ${stmt}`).catch(() => {});
        }
      });

      // 1. PRECONDITION. If the plan was re-planned per execution there is no cached plan to freeze
      //    anything, and everything below is vacuous.
      expect(
        Number(out.stats.generic_plans),
        `the generic plan was not reused (generic=${out.stats.generic_plans}, custom=${out.stats.custom_plans}), ` +
          `so this test proves nothing about plan caching.`,
      ).toBeGreaterThanOrEqual(2);

      // 2. DETECTOR CONTROL. The broken clone must still report the FIRST principal's keyring after
      //    the identity switch. If this fails, plan-time folding does not reach a function of this
      //    shape on this server, the defect class is unreachable, and the three prose sites above are
      //    describing a mechanism that cannot fire — a finding to record, not a pass.
      expect(
        out.second.folded,
        `the IMMUTABLE clone did NOT freeze (first=${JSON.stringify(out.first.folded)}, ` +
          `second=${JSON.stringify(out.second.folded)}). Plan-time constant folding is not reaching it, ` +
          `so this harness cannot see the defect and the assertion below is vacuous. Record the finding ` +
          `and correct 0007:36-39, doctor.ts:229-231 and CONTEXT.md §2 rather than deleting this test.`,
      ).toEqual(bigGrants);

      // 2b. THE WRAPPER IS NOT A BACKUP. MEASURED across four shapes (plpgsql/sql x bare/wrapped):
      //     ALL FOUR freeze. `(SELECT fn())` does not block constant folding, and neither does
      //     LANGUAGE SQL inlining. So STABLE is the SOLE barrier — 0007:36-39 is right, and it is
      //     right on its own. Pinned here because the wrapper looks protective and is not: anyone
      //     relaxing current_grants() to IMMUTABLE on the theory that the policy's own `(SELECT …)`
      //     covers them would reopen this, and doctor's provolatile='s' pin would be the only thing
      //     left standing.
      expect(
        out.second.folded_wrapped,
        `the (SELECT …) wrapper blocked the fold on this server. That contradicts the measurement this ` +
          `test encodes; re-check whether STABLE is still the sole barrier before relying on either.`,
      ).toEqual(bigGrants);

      // 3. THE PROPERTY. The real function, on the same frozen plan, tracks the CURRENT identity —
      //    in both the bare and the wrapped form the policy actually uses.
      expect(out.first.live).toEqual(bigGrants);
      expect(out.second.live_wrapped, 'the policy\'s own call shape carried a stale keyring').toEqual(smallGrants);
      expect(out.second.live, 'public.current_grants() carried one principal\'s keyring into another\'s query').toEqual(smallGrants);
      // …and the rows follow it: the RLS predicate re-evaluated, it did not reuse a baked-in keyring.
      expect(out.second.n, 'the row count did not follow the identity switch').toBe(SMALL_PAGES);
      } finally {
        // Dropped by the test that CREATED it, not only by the outer afterAll. The schema carries a
        // live `grant usage … to cb_app`, and it was deliberately placed outside `public` so doctor's
        // snapshots cannot see it — which means a leftover is invisible to the one tool that would
        // otherwise report it. Narrowing the window to this test is the cheap half of that fix.
        await adminSql()`drop schema if exists cb_perf cascade`;
      }
    }, 180_000);
  });

  // ── C. Pool headroom: no transaction spans a model call (D6) ─────────────
  describe('pool headroom under concurrent generations (DB_POOL_MAX=2)', () => {
    let arrived = 0;
    let release: () => void = () => {};
    let gate: Promise<void>;

    beforeAll(async () => {
      mutableConfig.DB_POOL_MAX = 2;
      await closePools({ timeout: 5 });
      gate = new Promise<void>((r) => { release = r; });
      // Embeddings resolve immediately; the CHAT call parks until the test lets it go, which is what
      // holds every answerQuestion() simultaneously at the point where a transaction must NOT be open.
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('/embeddings')) {
          const body: { input: string | string[] } = JSON.parse(String(init?.body ?? '{}'));
          const inputs = Array.isArray(body.input) ? body.input : [body.input];
          return new Response(
            JSON.stringify({ data: inputs.map((t, i) => ({ index: i, embedding: fakeEmbedVector(t) })) }),
            { status: 200 },
          );
        }
        if (url.includes('/chat/completions')) {
          arrived += 1;
          await gate;
          return new Response(
            JSON.stringify({ choices: [{ message: { content: '{"answer":"stub","citations":[]}' } }] }),
            { status: 200 },
          );
        }
        throw new Error(`perf-recall: unexpected URL ${url}`);
      }) as unknown as typeof fetch;
    }, 60_000);

    afterAll(async () => {
      release();
      globalThis.fetch = installFakeAiFetch(() => '{"answer":"stub","citations":[]}');
      mutableConfig.DB_POOL_MAX = realPoolMax;
      await closePools({ timeout: 5 });
    }, 60_000);

    /** Can a trivial scoped query get a connection right now? */
    const probe = (): Promise<'ok' | 'timeout'> =>
      Promise.race([
        withScopedTx(ctxSmall(), (tx) => tx`select 1 as ok`).then(() => 'ok' as const),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 3_000)),
      ]);

    it('C1 control: the probe can actually detect an exhausted pool', async () => {
      // Without this, C2's 'ok' proves nothing — a probe that can only ever return 'ok' is not a
      // measurement. Hold exactly DB_POOL_MAX transactions open and confirm the probe times out.
      let releaseHolders: () => void = () => {};
      const held = new Promise<void>((r) => { releaseHolders = r; });
      const holders = Array.from({ length: 2 }, () => withScopedTx(ctxSmall(), async (tx) => {
        await tx`select 1`;
        await held;
      }));
      try {
        expect(await probe(), 'the probe returned ok with every connection held — it cannot detect exhaustion').toBe('timeout');
      } finally {
        releaseHolders();
        await Promise.all(holders);
      }
    }, 120_000);

    it('C2 property: six concurrent answers leave the pool free — no tx spans the model call', async () => {
      const N = 6;
      // try/finally around everything below, because the assertion that can fail is the one that
      // fails EXACTLY when the defect this test detects is present: a transaction held across chat()
      // stops the last four from starting. Without the finally, `release()` never runs, six
      // generations stay parked, and the describe's afterAll calls closePools() underneath them —
      // producing unhandled rejections attributed to whichever file bun runs next.
      const answers = Array.from({ length: N }, () => answerQuestion(ctxSmall(), QUERY));
      try {
        // Bounded, and deliberately well under idle_in_transaction_session_timeout (15s): if a
        // transaction WERE held across the model call, waiting past that timeout would surface as a
        // confusing 25P03 instead of this message.
        const deadline = Date.now() + 10_000;
        while (arrived < N && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
        expect(
          arrived,
          `only ${arrived} of ${N} answers reached the model call. With DB_POOL_MAX=2, that is what a ` +
            `transaction held across chat() looks like: the first two occupy the pool and the rest ` +
            `cannot even start their retrieval (D6).`,
        ).toBe(N);

        // The property. Every answer is parked mid-generation and the pool is still serving.
        expect(await probe(), 'the pool is exhausted while six answers sit in the model call').toBe('ok');

        release();
        const settled = await Promise.all(answers);
        expect(settled.length).toBe(N);
        for (const a of settled) expect(a.answer.length).toBeGreaterThan(0);
      } finally {
        // Idempotent: release() twice is harmless, and allSettled drains whatever is still parked so
        // no rejection outlives this test.
        release();
        await Promise.allSettled(answers);
      }
    }, 180_000);
  });
});
