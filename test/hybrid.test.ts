// Live DB test for hybrid search. embed() is mocked (fake-ai helper, deterministic per-string
// vectors) so keyword-arm and vector-arm behavior are each independently verifiable without real
// API cost — retrieval QUALITY against a real corpus is validated by `bun run eval:a17`.
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { adminSql, closePools } from '../src/db/client.ts';
import { buildContext, resolveGrants } from '../src/core/context.ts';
import { importPage } from '../src/ingest/import.ts';
import { hybridSearch } from '../src/search/hybrid.ts';
import { config } from '../src/config.ts';
import { installFakeAiFetch } from './helpers/fake-ai.ts';

const live = !!process.env.DATABASE_URL && !!process.env.DATABASE_ADMIN_URL;
const mutableConfig = config as unknown as Record<string, unknown>;

describe.skipIf(!live)('hybridSearch — live', () => {
  let ws1 = '';
  let ws2 = '';
  let p1 = '';
  let p2 = '';
  const realFetch = globalThis.fetch;
  const realKey = mutableConfig.OPENAI_API_KEY;
  const EXACT_SENTENCE = 'The zebra migration route crosses the northern salt flats every spring.';

  beforeAll(async () => {
    mutableConfig.OPENAI_API_KEY = 'test-key';
    globalThis.fetch = installFakeAiFetch();

    const admin = adminSql();
    p1 = (await admin<{ id: string }[]>`insert into principals (email, email_normalized) values (${'hybrid-a@ex.com'}, ${'hybrid-a@ex.com'}) returning id`)[0]!.id;
    p2 = (await admin<{ id: string }[]>`insert into principals (email, email_normalized) values (${'hybrid-b@ex.com'}, ${'hybrid-b@ex.com'}) returning id`)[0]!.id;
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

  it('a query with no keyword match still returns without throwing (vector arm always ranks all rows)', async () => {
    const ctx = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });
    const hits = await hybridSearch(ctx, 'qwertyuiopasdfghjklzxcvbnm-no-such-token');
    expect(Array.isArray(hits)).toBe(true);
  });

  it('workspace isolation: a second, empty workspace sees none of the first workspace\'s content', async () => {
    const ctx2 = buildContext({ principal: p2, workspaceId: ws2, role: 'owner', grants: resolveGrants(p2, ws2), remote: false });
    const hits = await hybridSearch(ctx2, 'zzzqqqmarker');
    expect(hits).toHaveLength(0);
  });
});
