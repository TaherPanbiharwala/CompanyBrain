// list_pages / delete_page / replace_page.
//
// These are the first DESTRUCTIVE operations in the registry, which changes what a test has to
// prove. For a read op the question is "did it show the wrong rows"; for these it is "did it destroy
// the wrong rows", and a wrong answer is not recoverable by fixing the code afterwards. So the
// cross-tenant and cross-author cases here are not a formality — they are the whole point.
//
// The leak canary's registry sweep allowlists delete_page and replace_page, naming THIS file as
// their coverage. If these cases weaken, that allowlist entry becomes a false statement.
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { liveOrFail, hasDbEnv } from './helpers/live.ts';
import { installFakeAiFetch } from './helpers/fake-ai.ts';
import { adminSql, withScopedTx, closePools } from '../src/db/client.ts';
import { buildContext, resolveGrants, type OperationContext } from '../src/core/context.ts';
import { importPage } from '../src/ingest/import.ts';
import { listPages, deletePage, replacePage } from '../src/ingest/lifecycle.ts';
import { OperationError } from '../src/api/errors.ts';
import { config } from '../src/config.ts';

const RUN = crypto.randomUUID().slice(0, 8);
const live = liveOrFail('lifecycle', hasDbEnv());
const mutableConfig = config as unknown as Record<string, unknown>;

/** Run `fn`; return the OperationError code it threw, or undefined if it succeeded. Distinct from
 *  deniedCode (a SQLSTATE): here the control under test is in the app layer, so the thing to assert
 *  is the wire code a caller would actually see. */
async function opCode(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e instanceof OperationError ? e.code : `unexpected: ${(e as Error).message}`;
  }
}

describe.skipIf(!live)('page lifecycle', () => {
  let ws1 = '';
  let ws2 = '';
  let pA = ''; // author, owner of ws1
  let pB = ''; // colleague in ws1, plain member
  let pC = ''; // unrelated tenant

  const realFetch = globalThis.fetch;
  const realOpenAI = mutableConfig.OPENAI_API_KEY;
  const realOpenRouter = mutableConfig.OPENROUTER_API_KEY;

  const ctxFor = (principal: string, workspaceId: string, role = 'owner'): OperationContext =>
    buildContext({ principal, workspaceId, role, grants: resolveGrants(principal, workspaceId), remote: false });

  const ctxA = (): OperationContext => ctxFor(pA, ws1);
  const ctxB = (): OperationContext => ctxFor(pB, ws1, 'member');
  const ctxC = (): OperationContext => ctxFor(pC, ws2);

  beforeAll(async () => {
    mutableConfig.OPENAI_API_KEY = 'test-key';
    mutableConfig.OPENROUTER_API_KEY = 'test-key';
    globalThis.fetch = installFakeAiFetch(() => '{"answer":"stub","citations":[]}');

    const admin = adminSql();
    const mkPrincipal = async (tag: string) =>
      (
        await admin<{ id: string }[]>`
          insert into principals (email, email_normalized)
          values (${`lc-${tag}-${RUN}@ex.com`}, ${`lc-${tag}-${RUN}@ex.com`}) returning id`
      )[0]!.id;

    pA = await mkPrincipal('a');
    pB = await mkPrincipal('b');
    pC = await mkPrincipal('c');

    const mkWorkspace = async (name: string, owner: string) =>
      (await admin<{ id: string }[]>`insert into workspaces (name, created_by) values (${name}, ${owner}) returning id`)[0]!.id;

    ws1 = await mkWorkspace(`lc-ws1-${RUN}`, pA);
    ws2 = await mkWorkspace(`lc-ws2-${RUN}`, pC);

    await admin`
      insert into workspace_members (workspace_id, principal_id, role) values
        (${ws1}, ${pA}, 'owner'), (${ws1}, ${pB}, 'member'), (${ws2}, ${pC}, 'owner')`;
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

  /** Each test seeds its own pages, so no case depends on another's leftovers or ordering. */
  const seed = async (ctx: OperationContext, slug: string, body: string, scope: 'private' | 'workspace' = 'workspace') =>
    importPage(ctx, { slug: `${slug}-${RUN}`, title: slug, body, scope });

  describe('list_pages', () => {
    it('shows the caller their pages with a chunk count, newest-updated first', async () => {
      await seed(ctxA(), 'lp-one', 'The renewal terms run for twelve months from signature.');
      await seed(ctxA(), 'lp-two', 'The per-robot fee is 3900 with a volume discount above forty units.');

      const { pages } = await listPages(ctxA(), { limit: 200 });
      const mine = pages.filter((p) => p.slug.endsWith(RUN));
      expect(mine.length).toBeGreaterThanOrEqual(2);
      // A page with zero chunks is a page that is invisible to search while looking perfectly fine
      // in a listing — the count is here so that state is observable rather than inferred.
      for (const p of mine) expect(p.chunkCount).toBeGreaterThan(0);
      expect(mine.every((p) => p.hasSource === false)).toBe(true);
    }, 120_000);

    it("omits a colleague's private page — the same filter search uses", async () => {
      const priv = await seed(ctxA(), 'lp-private', 'A private note about compensation bands.', 'private');
      const { pages } = await listPages(ctxB(), { limit: 200 });
      expect(pages.map((p) => p.id)).not.toContain(priv.pageId);
      // Positive control: B is not simply seeing an empty list.
      expect(pages.some((p) => p.slug === `lp-one-${RUN}`), 'B sees no shared pages either — the negative is vacuous').toBe(true);
    }, 120_000);

    it('shows no page from another tenant', async () => {
      await seed(ctxC(), 'lp-other-tenant', 'Content belonging to an entirely different company.');
      const { pages } = await listPages(ctxA(), { limit: 200 });
      expect(pages.map((p) => p.slug)).not.toContain(`lp-other-tenant-${RUN}`);
    }, 120_000);

    it('paginates without skipping or repeating rows', async () => {
      // updated_at alone is not a stable sort — rows written in one transaction share a timestamp to
      // the microsecond — so LIMIT/OFFSET over it silently drops and duplicates rows across pages.
      // The id tiebreak is what makes this hold.
      const first = await listPages(ctxA(), { limit: 2, offset: 0 });
      const second = await listPages(ctxA(), { limit: 2, offset: 2 });
      expect(first.pages).toHaveLength(2);
      expect(first.hasMore).toBe(true);
      const overlap = first.pages.map((p) => p.id).filter((id) => second.pages.some((p) => p.id === id));
      expect(overlap, 'a row appeared on two pages of the same listing').toEqual([]);
    }, 120_000);
  });

  describe('delete_page', () => {
    it('removes the page and cascades its chunks', async () => {
      const page = await seed(ctxA(), 'del-basic', 'Northstar Robotics reported 4.2 crore in quarterly revenue.');
      const before = await withScopedTx(ctxA(), (tx) =>
        tx<{ n: number }[]>`select count(*)::int as n from content_chunks where page_id = ${page.pageId}`);
      expect(before[0]!.n).toBeGreaterThan(0);

      const result = await deletePage(ctxA(), { pageId: page.pageId });
      expect(result.pageId).toBe(page.pageId);
      expect(result.sourceRemoved).toBe(false);

      // Counted on the OWNER pool, not through RLS: a scoped count cannot distinguish "the chunks
      // are gone" from "the chunks are merely invisible to me now", and only one of those is the
      // claim being made.
      const after = await adminSql()<{ n: number }[]>`
        select count(*)::int as n from content_chunks where page_id = ${page.pageId}`;
      expect(after[0]!.n, 'chunks survived their page — the FK cascade did not fire').toBe(0);
    }, 120_000);

    it('cascades the stored source file, and reports that it did', async () => {
      const page = await seed(ctxA(), 'del-with-source', 'A page that also has its original bytes retained.');
      await withScopedTx(ctxA(), async (tx) => {
        const acl = (await tx<{ acl: string[] }[]>`select acl from pages where id = ${page.pageId}`)[0]!.acl;
        await tx`
          insert into page_sources (page_id, workspace_id, acl, filename, sha256, byte_len, bytes)
          values (${page.pageId}, ${ws1}, ${acl}, ${'orig.pdf'}, ${'a'.repeat(64)}, ${4}, ${Buffer.from('data')})`;
      });

      const result = await deletePage(ctxA(), { pageId: page.pageId });
      // The caller has to be told: this row is the only copy of the file (D71), so the delete just
      // destroyed a user's upload, not merely an index entry.
      expect(result.sourceRemoved).toBe(true);
      const after = await adminSql()<{ n: number }[]>`
        select count(*)::int as n from page_sources where page_id = ${page.pageId}`;
      expect(after[0]!.n).toBe(0);
    }, 120_000);

    it('a page in another tenant is not addressable by id — not_found, not permission_denied', async () => {
      // The distinction matters: permission_denied would confirm the id names a real page somewhere,
      // turning delete_page into an existence oracle over every workspace in the database.
      const other = await seed(ctxC(), 'del-cross-tenant', 'A page belonging to a different company entirely.');
      expect(await opCode(() => deletePage(ctxA(), { pageId: other.pageId }))).toBe('not_found');

      const still = await adminSql()<{ n: number }[]>`select count(*)::int as n from pages where id = ${other.pageId}`;
      expect(still[0]!.n, 'a cross-tenant delete actually removed the row').toBe(1);
    }, 120_000);

    it("a colleague cannot delete a page they did not author, even though they can read it", async () => {
      // An APP-LAYER control with nothing beneath it: cb_app holds table DELETE on pages, and the
      // policy is `acl && current_grants()`, which every member satisfies for every shared page
      // because they all hold ws:<workspace>. The database's answer here is yes. Nothing but this
      // test will catch a regression.
      const page = await seed(ctxA(), 'del-not-mine', 'A shared page authored by A and readable by B.');
      expect(await opCode(() => deletePage(ctxB(), { pageId: page.pageId }))).toBe('permission_denied');

      const still = await adminSql()<{ n: number }[]>`select count(*)::int as n from pages where id = ${page.pageId}`;
      expect(still[0]!.n).toBe(1);
    }, 120_000);

    it('an admin CAN delete a page they did not author', async () => {
      const page = await seed(ctxA(), 'del-admin-can', 'A shared page an admin is entitled to remove.');
      const asAdmin = ctxFor(pB, ws1, 'admin');
      await deletePage(asAdmin, { pageId: page.pageId });
      const still = await adminSql()<{ n: number }[]>`select count(*)::int as n from pages where id = ${page.pageId}`;
      expect(still[0]!.n).toBe(0);
    }, 120_000);

    it('refuses an ambiguous slug rather than deleting the wrong page', async () => {
      // The concrete hazard migration 0007 created: it replaced UNIQUE(workspace_id, slug) with two
      // PARTIAL unique indexes, so a shared page and a private page may hold the same slug at once.
      // `delete ... where slug = $1` would destroy whichever the planner returned first.
      const slug = `del-ambiguous-${RUN}`;
      await importPage(ctxA(), { slug, title: 'shared', body: 'The shared one.', scope: 'workspace' });
      await importPage(ctxA(), { slug, title: 'private', body: 'The private one.', scope: 'private' });

      expect(await opCode(() => deletePage(ctxA(), { slug }))).toBe('invalid_params');
      const still = await adminSql()<{ n: number }[]>`
        select count(*)::int as n from pages where slug = ${slug}`;
      expect(still[0]!.n, 'an ambiguous slug delete removed a page anyway').toBe(2);
    }, 120_000);

    it('deletes by slug when it is unambiguous', async () => {
      const page = await seed(ctxA(), 'del-by-slug', 'A page addressed by its slug alone.');
      const result = await deletePage(ctxA(), { slug: `del-by-slug-${RUN}` });
      expect(result.pageId).toBe(page.pageId);
    }, 120_000);

    it('requires exactly one of pageId and slug', async () => {
      expect(await opCode(() => deletePage(ctxA(), {}))).toBe('invalid_params');
      expect(await opCode(() => deletePage(ctxA(), { pageId: crypto.randomUUID(), slug: 'x' }))).toBe('invalid_params');
    }, 60_000);
  });

  describe('replace_page', () => {
    it('swaps the chunks, keeps the id and slug, and stamps updated_at', async () => {
      const page = await seed(ctxA(), 'rep-basic', 'The original text mentions a marker word: alphamarker.');
      const before = await adminSql()<{ created_at: Date; updated_at: Date }[]>`
        select created_at, updated_at from pages where id = ${page.pageId}`;

      const result = await replacePage(ctxA(), {
        pageId: page.pageId,
        body: 'The replacement text mentions a different marker word: betamarker.',
      });
      expect(result.pageId).toBe(page.pageId);
      expect(result.chunkCount).toBeGreaterThan(0);

      const chunks = await withScopedTx(ctxA(), (tx) =>
        tx<{ content: string }[]>`select content from content_chunks where page_id = ${page.pageId}`);
      const joined = chunks.map((c) => c.content).join(' ');
      expect(joined).toContain('betamarker');
      // The old chunks must be GONE, not merely outnumbered — a stale chunk keeps answering
      // questions from text the page no longer contains.
      expect(joined, 'the replaced text is still retrievable').not.toContain('alphamarker');

      const after = await adminSql()<{ updated_at: Date }[]>`select updated_at from pages where id = ${page.pageId}`;
      // updated_at was written by NOTHING before this op existed (importPage only inserts), so M6's
      // Drive change detection would have seen every re-synced page as untouched.
      expect(after[0]!.updated_at.getTime()).toBeGreaterThan(before[0]!.updated_at.getTime());
    }, 120_000);

    it('stamps the new chunks with the acl from the PAGE, not from anything the caller passed', async () => {
      // Chunk-acl drift filters chunks independently of their page: search silently returns fewer
      // hits and nothing errors. `bun run doctor` counts exactly this state.
      const page = await seed(ctxA(), 'rep-acl', 'A private page whose chunks must stay private.', 'private');
      await replacePage(ctxA(), { pageId: page.pageId, body: 'Replacement text for the private page.' });

      const rows = await adminSql()<{ page_acl: string[]; chunk_acl: string[] }[]>`
        select p.acl as page_acl, c.acl as chunk_acl
          from content_chunks c join pages p on p.id = c.page_id
         where c.page_id = ${page.pageId}`;
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(r.chunk_acl).toEqual(r.page_acl);
    }, 120_000);

    it('keeps the title and tags when they are omitted', async () => {
      const page = await importPage(ctxA(), {
        slug: `rep-keep-${RUN}`,
        title: 'Original title',
        body: 'Some original body text about routing.',
        tags: ['keepme'],
        scope: 'workspace',
      });
      await replacePage(ctxA(), { pageId: page.pageId, body: 'Replacement body about routing.' });
      const row = (await adminSql()<{ title: string; tags: string[] }[]>`
        select title, tags from pages where id = ${page.pageId}`)[0]!;
      expect(row.title).toBe('Original title');
      expect(row.tags).toEqual(['keepme']);
    }, 120_000);

    it('refuses a page created from an uploaded file', async () => {
      // Every alternative destroys something silently: overwriting the body leaves the retained file
      // describing text that is no longer indexed (so a citation reading "p.7" points into a
      // document that no longer matches), and clearing the file deletes a user's only copy as a side
      // effect of an edit they did not describe as destructive.
      const page = await seed(ctxA(), 'rep-file-sourced', 'Text that was extracted from a PDF.');
      await withScopedTx(ctxA(), async (tx) => {
        const acl = (await tx<{ acl: string[] }[]>`select acl from pages where id = ${page.pageId}`)[0]!.acl;
        await tx`
          insert into page_sources (page_id, workspace_id, acl, filename, sha256, byte_len, bytes)
          values (${page.pageId}, ${ws1}, ${acl}, ${'contract.pdf'}, ${'b'.repeat(64)}, ${4}, ${Buffer.from('data')})`;
      });

      expect(await opCode(() => replacePage(ctxA(), { pageId: page.pageId, body: 'Pasted replacement.' }))).toBe(
        'invalid_params',
      );
      // …and it refused BEFORE touching anything.
      const chunks = await adminSql()<{ n: number }[]>`
        select count(*)::int as n from content_chunks where page_id = ${page.pageId}`;
      expect(chunks[0]!.n).toBeGreaterThan(0);
    }, 120_000);

    it('a colleague cannot replace a page they did not author', async () => {
      const page = await seed(ctxA(), 'rep-not-mine', 'A shared page authored by A.');
      expect(await opCode(() => replacePage(ctxB(), { pageId: page.pageId, body: 'Rewritten by B.' }))).toBe(
        'permission_denied',
      );
      const row = (await adminSql()<{ body: string }[]>`select body from pages where id = ${page.pageId}`)[0]!;
      expect(row.body).toContain('authored by A');
    }, 120_000);

    it('a page in another tenant is not addressable', async () => {
      const other = await seed(ctxC(), 'rep-cross-tenant', 'A page in a different company.');
      expect(await opCode(() => replacePage(ctxA(), { pageId: other.pageId, body: 'Rewritten across tenants.' }))).toBe(
        'not_found',
      );
      const row = (await adminSql()<{ body: string }[]>`select body from pages where id = ${other.pageId}`)[0]!;
      expect(row.body).toContain('different company');
    }, 120_000);

    it('refuses before spending an embedding call', async () => {
      // The ordering is the assertion. Every reason to refuse is checked in phase 1, before the
      // embed, because that call is the only unrecoverable cost in the op — a rejected replace that
      // has already paid for embeddings has thrown money away for nothing.
      const page = await seed(ctxA(), 'rep-no-spend', 'A shared page authored by A.');
      let embedCalls = 0;
      const counting = installFakeAiFetch(() => '{"answer":"stub","citations":[]}');
      globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes('embed')) embedCalls++;
        return counting(input as never, init as never);
      }) as typeof fetch;
      try {
        expect(await opCode(() => replacePage(ctxB(), { pageId: page.pageId, body: 'Rewritten by B.' }))).toBe(
          'permission_denied',
        );
        expect(embedCalls, 'the refusal happened AFTER paying to embed').toBe(0);

        // POSITIVE CONTROL, and this test is worthless without it: a counter that never increments
        // reports zero for a refusal, for a success, and for a router URL that stopped containing
        // "embed". Only a run that DOES reach the embedder proves the zero above measured anything.
        await replacePage(ctxA(), { pageId: page.pageId, body: 'Rewritten by its actual author.' });
        expect(embedCalls, 'a successful replace did not reach the embedder — the counter is blind').toBeGreaterThan(0);
      } finally {
        globalThis.fetch = counting;
      }
    }, 120_000);
  });
});
