// Live DB test for hybrid search. embed() is mocked (fake-ai helper, deterministic per-string
// vectors) so keyword-arm and vector-arm behavior are each independently verifiable without real
// API cost — retrieval QUALITY against a real corpus is validated by `bun run eval:a17`.
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { liveOrFail, hasDbEnv } from './helpers/live.ts';
import { adminSql, closePools } from '../src/db/client.ts';
import { buildContext, resolveGrants } from '../src/core/context.ts';
import { importPage } from '../src/ingest/import.ts';
import { hybridSearch } from '../src/search/hybrid.ts';
import { rrfFuse } from '../src/search/rrf.ts';
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

describe.skipIf(!live)('hybridSearch — live', () => {
  let ws1 = '';
  let ws2 = '';
  let p1 = '';
  let p2 = '';
  const realFetch = globalThis.fetch;
  const realKey = mutableConfig.OPENAI_API_KEY;
  const EXACT_SENTENCE = 'The zebra migration route crosses the northern salt flats every spring.';
  // Every page beforeAll ingests into ws1. Kept beside the fixture so an added page updates both.
  const WS1_SLUGS = ['keyword-doc', 'filler-doc', 'exact-doc'];

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
  }, { timeout: 20000 }); // 3 importPage calls, each several round trips to the remote DB — past the 5s default

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
    const hits = await hybridSearch(ctx, 'zzzqqqmarker');
    expect(hits.some((h) => h.slug === 'keyword-doc')).toBe(true);
  });

  it('vector arm ranks an exact-content match first (identical text -> identical fake embedding)', async () => {
    const ctx = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });
    const hits = await hybridSearch(ctx, EXACT_SENTENCE);
    expect(hits[0]?.slug).toBe('exact-doc');
  });

  it('a query with no keyword match still returns hits (the vector arm ranks all rows)', async () => {
    const ctx = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });
    const hits = await hybridSearch(ctx, 'qwertyuiopasdfghjklzxcvbnm-no-such-token');
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

  it('the SQL fusion agrees with rrfFuse, which stays the specification', async () => {
    // hybridSearch moved RRF into the query to save a round trip (D65). That is only safe if the SQL
    // arithmetic matches the reference implementation EXACTLY, and there are two traps in it:
    // rrfFuse ranks from zero while row_number() starts at one, and RRF ties are common so both
    // sides must break them the same way. Running the arms separately here and fusing in TypeScript
    // reproduces the old code path, so this test fails the moment the two drift.
    const ctx = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });
    const query = 'zebra salt flats zzzqqqmarker bread';

    const viaSql = await hybridSearch(ctx, query);

    const [qv] = await withRouterScope({ workspaceId: ws1, zdr: false }, () => embed([query]));
    const lit = toVectorLiteral(qv!);
    const { kw, vec } = await withScopedTx(ctx, async (tx) => {
      const kw = await tx<{ id: string }[]>`
        select c.id from content_chunks c
        where to_tsvector('english', c.content) @@ plainto_tsquery('english', ${query})
        order by ts_rank_cd(to_tsvector('english', c.content), plainto_tsquery('english', ${query})) desc
        limit 20`;
      const vec = await tx<{ id: string }[]>`
        select c.id from content_chunks c
        where c.embedding is not null
        order by c.embedding <=> ${lit}::vector
        limit 20`;
      return { kw, vec };
    });
    const viaTs = rrfFuse([kw.map((r) => r.id), vec.map((r) => r.id)]).slice(0, 8).map((r) => r.id);

    expect(viaSql.length).toBeGreaterThan(0); // a vacuous [] === [] would prove nothing
    expect(viaSql.map((h) => h.chunkId)).toEqual(viaTs);
  }, 30_000);

  it('workspace isolation: a second, empty workspace sees none of the first workspace\'s content', async () => {
    const ctx2 = buildContext({ principal: p2, workspaceId: ws2, role: 'owner', grants: resolveGrants(p2, ws2), remote: false });
    const hits = await hybridSearch(ctx2, 'zzzqqqmarker');
    expect(hits).toHaveLength(0);
  });
});
