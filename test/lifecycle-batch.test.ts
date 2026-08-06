// The batch page ops: delete_page's pageIds arm, and rescope_pages.
//
// These shipped as 216 lines of permission-touching SQL with no test, and test/leak-canary.test.ts's
// allowlist claimed they were "covered by test/lifecycle.test.ts" when that file never mentioned
// them — a vacuous exemption in the one suite this project calls sacred. This file discharges it.
//
// The property that matters most here is NOT "does the delete work". It is that these ops PARTITION
// rather than abort: an undo where 3 of 250 pages belong to a colleague must remove the 247 and
// report the 3, because the alternative is a user who retries the whole thing.
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { liveOrFail, hasDbEnv } from './helpers/live.ts';
import { installFakeAiFetch } from './helpers/fake-ai.ts';
import { adminSql, closePools } from '../src/db/client.ts';
import { buildContext, resolveGrants, type OperationContext } from '../src/core/context.ts';
import { importPage } from '../src/ingest/import.ts';
import { deletePages, rescopePages, MAX_BATCH_PAGES } from '../src/ingest/lifecycle.ts';
import { dispatchOp } from '../src/api/dispatch.ts';
import { config } from '../src/config.ts';

const RUN = crypto.randomUUID().slice(0, 8);
const live = liveOrFail('lifecycle-batch', hasDbEnv());
const mutableConfig = config as unknown as Record<string, unknown>;

describe.skipIf(!live)('batch page operations', () => {
  let ws1 = '';
  let ws2 = '';
  let pA = ''; // author, owner of ws1
  let pB = ''; // colleague in ws1, admin (so canWrite lets them through)
  let pC = ''; // unrelated tenant
  let otherTenantPageId = '';

  const realFetch = globalThis.fetch;
  const realOpenAI = mutableConfig.OPENAI_API_KEY;
  const realOpenRouter = mutableConfig.OPENROUTER_API_KEY;

  const ctxFor = (principal: string, workspaceId: string, role = 'owner'): OperationContext =>
    buildContext({ principal, workspaceId, role, grants: resolveGrants(principal, workspaceId), remote: false });

  /** A fresh page, so each test owns its own rows and order never matters. */
  const mkPage = async (ctx: OperationContext, tag: string, scope: 'private' | 'workspace') =>
    (
      await importPage(ctx, {
        slug: `batch-${tag}-${RUN}-${crypto.randomUUID().slice(0, 6)}`,
        title: `batch ${tag}`,
        body: `Body text long enough to clear the sanity floor for the ${tag} case in this suite.`,
        scope,
      })
    ).pageId;

  beforeAll(async () => {
    mutableConfig.OPENAI_API_KEY = 'test-key';
    mutableConfig.OPENROUTER_API_KEY = 'test-key';
    globalThis.fetch = installFakeAiFetch(() => '{"answer":"stub","citations":[]}');

    const admin = adminSql();
    const mkPrincipal = async (tag: string) =>
      (
        await admin<{ id: string }[]>`
          insert into principals (email, email_normalized)
          values (${`batch-${tag}-${RUN}@ex.com`}, ${`batch-${tag}-${RUN}@ex.com`}) returning id`
      )[0]!.id;
    pA = await mkPrincipal('a');
    pB = await mkPrincipal('b');
    pC = await mkPrincipal('c');

    const mkWorkspace = async (name: string, owner: string) =>
      (await admin<{ id: string }[]>`insert into workspaces (name, created_by) values (${name}, ${owner}) returning id`)[0]!.id;
    ws1 = await mkWorkspace(`batch-ws1-${RUN}`, pA);
    ws2 = await mkWorkspace(`batch-ws2-${RUN}`, pC);

    await admin`
      insert into workspace_members (workspace_id, principal_id, role) values
        (${ws1}, ${pA}, 'owner'), (${ws1}, ${pB}, 'admin'), (${ws2}, ${pC}, 'owner')`;

    otherTenantPageId = await mkPage(ctxFor(pC, ws2), 'other-tenant', 'workspace');
  }, 120_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    mutableConfig.OPENAI_API_KEY = realOpenAI;
    mutableConfig.OPENROUTER_API_KEY = realOpenRouter;
    const admin = adminSql();
    await admin`delete from workspaces where id in (${ws1}, ${ws2})`;
    await admin`delete from principals where id in (${pA}, ${pB}, ${pC})`;
    await closePools({ timeout: 5 });
  }, 60_000);

  describe('deletePages', () => {
    it("another tenant's page id is reported as invisible and NOT deleted", async () => {
      // This is the claim leak-canary.test.ts's allowlist makes on this op's behalf. Positive control
      // first: the batch must actually delete something, or "the other tenant's page survived" proves
      // only that the call did nothing.
      const mine = await mkPage(ctxFor(pA, ws1), 'own', 'workspace');
      const r = await deletePages(ctxFor(pA, ws1), [mine, otherTenantPageId]);

      expect(r.deleted).toBe(1);
      const foreign = r.outcomes.find((o) => o.pageId === otherTenantPageId)!;
      expect(foreign.ok).toBe(false);
      expect(foreign.code).toBe('not_visible');
      // Unknown and invisible MUST share one code, or the op becomes an existence oracle.
      expect(foreign.reason).toContain('no such page');

      const still = await adminSql()<{ n: number }[]>`
        select count(*)::int as n from pages where id = ${otherTenantPageId}`;
      expect(still[0]!.n).toBe(1);
    }, 120_000);

    it("a colleague's page is reported while every page you own still goes", async () => {
      const theirs = await mkPage(ctxFor(pB, ws1, 'admin'), 'colleague', 'workspace');
      const mine = [await mkPage(ctxFor(pA, ws1), 'p1', 'workspace'), await mkPage(ctxFor(pA, ws1), 'p2', 'workspace')];

      // pA is 'owner' of ws1, so canWrite would let them through — force the member path instead,
      // which is where partition-rather-than-abort actually matters.
      const r = await deletePages(ctxFor(pA, ws1, 'member'), [...mine, theirs]);

      expect(r.deleted).toBe(2);
      expect(r.outcomes.find((o) => o.pageId === theirs)!.code).toBe('not_author');
      expect(r.outcomes.filter((o) => o.ok).map((o) => o.pageId).sort()).toEqual([...mine].sort());
    }, 120_000);

    it('refuses more than MAX_BATCH_PAGES, and dedupes repeated ids', async () => {
      const tooMany = Array.from({ length: MAX_BATCH_PAGES + 1 }, () => crypto.randomUUID());
      await expect(deletePages(ctxFor(pA, ws1), tooMany)).rejects.toThrow(/more than one call may delete/);

      const one = await mkPage(ctxFor(pA, ws1), 'dupe', 'workspace');
      const r = await deletePages(ctxFor(pA, ws1), [one, one, one]);
      expect(r.deleted).toBe(1);
      expect(r.outcomes.length).toBe(1); // deduped before the query, not after
    }, 120_000);
  });

  describe('rescopePages', () => {
    it('promoting private → workspace moves the CHUNK acl too, not just the page row', async () => {
      // The ordering bug this guards: update the page first and its chunks keep the old grant, so the
      // page is listed but unretrievable — visible and useless, with nothing erroring.
      const id = await mkPage(ctxFor(pA, ws1), 'promote', 'private');
      const r = await rescopePages(ctxFor(pA, ws1), [id], 'workspace');
      expect(r.rescoped).toBe(1);

      const admin = adminSql();
      const page = await admin<{ acl: string[]; scope: string }[]>`select acl, scope from pages where id = ${id}`;
      const chunks = await admin<{ acl: string[] }[]>`select distinct acl from content_chunks where page_id = ${id}`;
      expect(page[0]!.scope).toBe('workspace');
      expect(chunks.length).toBe(1);
      expect(chunks[0]!.acl).toEqual(page[0]!.acl);
    }, 120_000);

    it('is idempotent: a page already at the target scope reports ok:true, not a failure', async () => {
      const id = await mkPage(ctxFor(pA, ws1), 'idem', 'workspace');
      const r = await rescopePages(ctxFor(pA, ws1), [id], 'workspace');
      expect(r.rescoped).toBe(0);
      const o = r.outcomes[0]!;
      expect(o.code).toBe('already_at_scope');
      // ok:false here would render a second click as "1 page was left alone" — a no-op shown as a fault.
      expect(o.ok).toBe(true);
    }, 120_000);

    it('an ADMIN may not make a colleague\'s page private — it would lock the author out', async () => {
      // aclForScope derives the private grant from the CALLER, so this would stamp self:<admin> onto
      // a page whose owner_principal is still the author. RLS is acl-based and canWrite is
      // owner-based, so they diverge and the author loses their own page permanently. 0007's
      // WITH CHECK would refuse it anyway; the app refuses first, with a message.
      const theirs = await mkPage(ctxFor(pA, ws1), 'admin-private', 'workspace');
      const r = await rescopePages(ctxFor(pB, ws1, 'admin'), [theirs], 'private');

      expect(r.rescoped).toBe(0);
      expect(r.outcomes[0]!.code).toBe('not_author');

      const row = await adminSql()<{ scope: string; acl: string[] }[]>`
        select scope, acl from pages where id = ${theirs}`;
      expect(row[0]!.scope).toBe('workspace');
      expect(row[0]!.acl.some((g) => g.startsWith('self:'))).toBe(false);
    }, 120_000);

    it('a slug already taken at the target scope is reported and the rest still move', async () => {
      const shared = await mkPage(ctxFor(pA, ws1), 'clash', 'workspace');
      const slug = (await adminSql()<{ slug: string }[]>`select slug from pages where id = ${shared}`)[0]!.slug;

      // A private page wearing the same slug — legal today, because 0007's slug indexes are PARTIAL
      // on scope. Promoting it must collide.
      const admin = adminSql();
      const clash = await mkPage(ctxFor(pA, ws1), 'clash-priv', 'private');
      await admin`update pages set slug = ${slug} where id = ${clash}`;
      const alsoFine = await mkPage(ctxFor(pA, ws1), 'clash-ok', 'private');

      const r = await rescopePages(ctxFor(pA, ws1), [clash, alsoFine], 'workspace');

      // The collision is PRE-CHECKED rather than caught: a 23505 would abort the transaction and
      // take alsoFine down with it, which is the whole reason the pre-check exists.
      expect(r.outcomes.find((o) => o.pageId === clash)!.code).toBe('slug_taken');
      expect(r.rescoped).toBe(1);
      expect(r.outcomes.find((o) => o.pageId === alsoFine)!.ok).toBe(true);
    }, 120_000);
  });

  describe('the delete_page XOR', () => {
    it('refuses pageIds alongside pageId, and deletes nothing', async () => {
      // The guard replacing the .refine() the registry cannot accept. Deleting it would make
      // {pageId, pageIds} silently take one arm and ignore the other, on an irreversible op.
      const a = await mkPage(ctxFor(pA, ws1), 'xor-a', 'workspace');
      const b = await mkPage(ctxFor(pA, ws1), 'xor-b', 'workspace');
      const res = await dispatchOp(ctxFor(pA, ws1), 'delete_page', { pageId: a, pageIds: [b] });

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('invalid_params');
      const n = await adminSql()<{ n: number }[]>`select count(*)::int as n from pages where id in (${a}, ${b})`;
      expect(n[0]!.n).toBe(2); // neither arm ran
    }, 120_000);
  });
});
