// Live DB coverage of M9's links table: backlinks populating on ingest, RLS cross-tenant isolation,
// the from_acl/to_acl conjunction specifically, soft-delete visibility via the join-based argument
// migration 0021 makes (no links.deleted_at column), concurrent reconciliation of the same page, and
// the link_extraction cycle phase end to end (the first real M8 phase consumer).
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { liveOrFail, hasDbEnv } from './helpers/live.ts';
import { installFakeAiFetch } from './helpers/fake-ai.ts';
import { adminSql, closePools, withScopedTx } from '../src/db/client.ts';
import { buildContext, resolveGrants, wsGrant } from '../src/core/context.ts';
import { importPage } from '../src/ingest/import.ts';
import { replacePage, deletePage } from '../src/ingest/lifecycle.ts';
import { extractAndReconcileLinks } from '../src/core/links/reconcile.ts';
import { runCycle } from '../src/core/cycle.ts';
import { config } from '../src/config.ts';

const RUN = crypto.randomUUID().slice(0, 8);
const live = liveOrFail('links', hasDbEnv());
const mutableConfig = config as unknown as Record<string, unknown>;

describe.skipIf(!live)('links (M9) — live', () => {
  let ws1 = '';
  let ws2 = '';
  let p1 = '';
  let p2 = '';
  const realFetch = globalThis.fetch;
  const realKey = mutableConfig.OPENAI_API_KEY;

  beforeAll(async () => {
    mutableConfig.OPENAI_API_KEY = 'test-key';
    globalThis.fetch = installFakeAiFetch();

    const admin = adminSql();
    p1 = (await admin<{ id: string }[]>`insert into principals (email, email_normalized) values (${`links-a-${RUN}@ex.com`}, ${`links-a-${RUN}@ex.com`}) returning id`)[0]!.id;
    p2 = (await admin<{ id: string }[]>`insert into principals (email, email_normalized) values (${`links-b-${RUN}@ex.com`}, ${`links-b-${RUN}@ex.com`}) returning id`)[0]!.id;
    ws1 = (await admin<{ id: string }[]>`insert into workspaces (name, created_by) values (${'links-ws1'}, ${p1}) returning id`)[0]!.id;
    ws2 = (await admin<{ id: string }[]>`insert into workspaces (name, created_by) values (${'links-ws2'}, ${p2}) returning id`)[0]!.id;
    await admin`insert into workspace_members (workspace_id, principal_id, role) values (${ws1}, ${p1}, 'owner'), (${ws1}, ${p2}, 'member'), (${ws2}, ${p2}, 'owner')`;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    mutableConfig.OPENAI_API_KEY = realKey;
    const admin = adminSql();
    await admin`delete from workspaces where id in (${ws1}, ${ws2})`;
    await admin`delete from principals where id in (${p1}, ${p2})`;
    await closePools({ timeout: 5 });
  });

  describe('backlinks populate on ingest', () => {
    it('importPage creates a mention edge to an already-existing page', async () => {
      const ctx1 = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });
      const target = await importPage(ctx1, { slug: `acme-contract-${RUN}`, title: `Acme Contract ${RUN}`, body: 'The terms of the deal.' });
      const source = await importPage(ctx1, { slug: `meeting-notes-${RUN}`, title: 'Meeting Notes', body: `We discussed the Acme Contract ${RUN} today.` });

      const admin = adminSql();
      const rows = await admin<{ to_page_id: string; link_kind: string }[]>`
        select to_page_id, link_kind from links where from_page_id = ${source.pageId}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.to_page_id).toBe(target.pageId);
      expect(rows[0]?.link_kind).toBe('mention');
    });

    it('replacePage re-runs extraction: stale edges are removed, new ones written', async () => {
      const ctx1 = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });
      const targetA = await importPage(ctx1, { slug: `topic-a-${RUN}`, title: `Topic Alpha ${RUN}`, body: 'About alpha.' });
      const targetB = await importPage(ctx1, { slug: `topic-b-${RUN}`, title: `Topic Beta ${RUN}`, body: 'About beta.' });
      const source = await importPage(ctx1, { slug: `report-${RUN}`, title: 'Report', body: `References Topic Alpha ${RUN}.` });

      const admin = adminSql();
      let rows = await admin<{ to_page_id: string }[]>`select to_page_id from links where from_page_id = ${source.pageId}`;
      expect(rows.map((r) => r.to_page_id)).toEqual([targetA.pageId]);

      await replacePage(ctx1, { pageId: source.pageId, body: `Now references Topic Beta ${RUN} instead.` });
      rows = await admin<{ to_page_id: string }[]>`select to_page_id from links where from_page_id = ${source.pageId}`;
      expect(rows.map((r) => r.to_page_id)).toEqual([targetB.pageId]);
    });
  });

  describe('RLS', () => {
    it('a link in one workspace is invisible from another', async () => {
      const ctx1 = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });
      const target = await importPage(ctx1, { slug: `ws1-target-${RUN}`, title: `WS1 Target ${RUN}`, body: 'x' });
      await importPage(ctx1, { slug: `ws1-source-${RUN}`, title: 'WS1 Source', body: `Mentions WS1 Target ${RUN}.` });

      const admin = adminSql();
      const [row] = await admin<{ n: number }[]>`select count(*)::int as n from links where to_page_id = ${target.pageId}`;
      expect(row?.n).toBeGreaterThan(0);

      // Scoped to ws2, via ws2's own owner (p2) — must see zero rows regardless of what exists in ws1.
      const ctx2 = buildContext({ principal: p2, workspaceId: ws2, role: 'owner', grants: resolveGrants(p2, ws2), remote: false });
      const seenFromWs2 = await withScopedTx(ctx2, (tx) => tx<{ id: string }[]>`select id from links where to_page_id = ${target.pageId}`);
      expect(seenFromWs2).toHaveLength(0);
    });

    it('from_acl/to_acl conjunction: a member who cannot see a private page sees no edge to or from it, even when they can see the other endpoint', async () => {
      // p1 owns a private page; p2 is a member of the SAME workspace but has no self:p1 grant, so
      // scope:'private' pages authored by p1 are invisible to p2 under normal RLS.
      const ctx1 = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });
      const privatePage = await importPage(ctx1, { slug: `private-plan-${RUN}`, title: `Private Plan ${RUN}`, scope: 'private', body: 'Confidential.' });
      const sharedPage = await importPage(ctx1, { slug: `shared-update-${RUN}`, title: 'Shared Update', body: `See the Private Plan ${RUN} for context.` });

      const admin = adminSql();
      const edge = await admin<{ id: string }[]>`select id from links where from_page_id = ${sharedPage.pageId} and to_page_id = ${privatePage.pageId}`;
      expect(edge, 'the edge itself must exist (created by its own author, p1)').toHaveLength(1);

      // p2 can see sharedPage (workspace-scoped) but not privatePage (self:p1-scoped) — so p2 must
      // see NO edge between them, proving the AND of from_acl/to_acl, not an OR.
      const ctx2 = buildContext({ principal: p2, workspaceId: ws1, role: 'member', grants: resolveGrants(p2, ws1), remote: false });
      const sharedVisibleToP2 = await withScopedTx(ctx2, (tx) => tx<{ id: string }[]>`select id from pages where id = ${sharedPage.pageId}`);
      expect(sharedVisibleToP2, 'sanity: p2 really can see the shared page directly').toHaveLength(1);
      const privateVisibleToP2 = await withScopedTx(ctx2, (tx) => tx<{ id: string }[]>`select id from pages where id = ${privatePage.pageId}`);
      expect(privateVisibleToP2, 'sanity: p2 really cannot see the private page directly').toHaveLength(0);

      const edgeVisibleToP2 = await withScopedTx(ctx2, (tx) => tx<{ id: string }[]>`
        select id from links where from_page_id = ${sharedPage.pageId} and to_page_id = ${privatePage.pageId}`);
      expect(edgeVisibleToP2, 'p2 can see one endpoint but not both, so the edge itself must be invisible').toHaveLength(0);
    });
  });

  describe('soft delete — no links.deleted_at column; visibility comes from the join', () => {
    it('an edge from a soft-deleted source page becomes invisible with no special-case code', async () => {
      const ctx1 = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });
      await importPage(ctx1, { slug: `still-here-${RUN}`, title: `Still Here ${RUN}`, body: 'x' });
      const source = await importPage(ctx1, { slug: `going-away-${RUN}`, title: 'Going Away', body: `Mentions Still Here ${RUN}.` });

      const admin = adminSql();
      let rows = await admin<{ id: string }[]>`select id from links where from_page_id = ${source.pageId}`;
      expect(rows).toHaveLength(1);

      await deletePage(ctx1, { pageId: source.pageId });

      // The raw links row still physically exists (soft delete never touches it)...
      rows = await admin<{ id: string }[]>`select id from links where from_page_id = ${source.pageId}`;
      expect(rows, 'soft delete does not touch links rows directly').toHaveLength(1);

      // ...but any RLS-scoped query joined through pages (the only way this milestone ever reads
      // links) no longer surfaces it, because pages_hide_deleted already filters the source out.
      // MUST run through a scoped connection, not adminSql() — the owner pool is BYPASSRLS, so the
      // restrictive hide-deleted policy this test exists to prove never applies to it at all (an
      // admin-pool version of this assertion would pass regardless of whether the real property
      // holds, which is exactly what a first draft of this test got wrong).
      const joined = await withScopedTx(ctx1, (tx) => tx<{ id: string }[]>`
        select l.id from links l join pages p on p.id = l.from_page_id where l.from_page_id = ${source.pageId}`);
      expect(joined, 'joined through pages, the edge from a soft-deleted page disappears for free').toHaveLength(0);
    });
  });

  describe('concurrent reconciliation', () => {
    it('two concurrent reconciliations of the same page do not crash or corrupt state', async () => {
      const ctx1 = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });
      const target = await importPage(ctx1, { slug: `concurrent-target-${RUN}`, title: `Concurrent Target ${RUN}`, body: 'x' });
      const source = await importPage(ctx1, { slug: `concurrent-source-${RUN}`, title: 'Concurrent Source', body: `Mentions Concurrent Target ${RUN}.` });

      const run = () => withScopedTx(ctx1, (tx) =>
        extractAndReconcileLinks(tx, { workspaceId: ws1, pageId: source.pageId, pageAcl: [wsGrant(ws1)], text: `Mentions Concurrent Target ${RUN}.` }));

      await expect(Promise.all([run(), run()])).resolves.toBeDefined();

      const admin = adminSql();
      const rows = await admin<{ id: string }[]>`select id from links where from_page_id = ${source.pageId} and to_page_id = ${target.pageId}`;
      expect(rows, 'no duplicate rows despite two concurrent reconciliations').toHaveLength(1);
    });
  });

  describe('link_extraction cycle phase — the first real M8 phase consumer', () => {
    it('backfills edges for pages whose extraction never ran (e.g. pre-dates this feature), and discovers backward mentions', async () => {
      const admin = adminSql();
      const ctx1 = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });

      // Simulate a pre-existing page by inserting directly (bypassing importPage, so no hook runs).
      const acl = [wsGrant(ws1)];
      const [older] = await admin<{ id: string }[]>`
        insert into pages (workspace_id, slug, title, owner_principal, scope, acl, body)
        values (${ws1}, ${`older-page-${RUN}`}, ${'Older Page'}, ${p1}, 'workspace', ${acl}, ${`Mentions a page called New Target ${RUN} that does not exist yet.`})
        returning id`;
      expect(older).toBeDefined();

      // Now the "new" page gets created for real, through the normal hook — which cannot retroactively
      // link the OLDER page back to it (the hook only computes outgoing edges at write time).
      const newer = await importPage(ctx1, { slug: `new-target-${RUN}`, title: `New Target ${RUN}`, body: 'x' });
      let rows = await admin<{ id: string }[]>`select id from links where from_page_id = ${older!.id} and to_page_id = ${newer.pageId}`;
      expect(rows, 'the hook alone cannot discover this backward mention').toHaveLength(0);

      const report = await runCycle({ workspaceId: ws1, phases: ['link_extraction'] });
      expect(report.status).toBe('ok');
      expect(report.phases[0]?.phase).toBe('link_extraction');

      rows = await admin<{ id: string }[]>`select id from links where from_page_id = ${older!.id} and to_page_id = ${newer.pageId}`;
      expect(rows, 'the cycle phase re-walk discovers it').toHaveLength(1);
    }, 60_000);

    it('dry run makes zero writes', async () => {
      const admin = adminSql();
      const before = (await admin<{ n: number }[]>`select count(*)::int as n from links where workspace_id = ${ws1}`)[0]!.n;
      const report = await runCycle({ workspaceId: ws1, phases: ['link_extraction'], dryRun: true });
      expect(report.status).toBe('ok');
      expect(report.phases[0]?.details?.dry_run).toBe(true);
      const after = (await admin<{ n: number }[]>`select count(*)::int as n from links where workspace_id = ${ws1}`)[0]!.n;
      expect(after).toBe(before);
    }, 60_000);
  });
});
