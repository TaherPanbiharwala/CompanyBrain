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
import { listPages, deletePage, replacePage, getPage } from '../src/ingest/lifecycle.ts';
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
    it('soft-deletes the page and marks its chunks deleted (migration 0014)', async () => {
      const page = await seed(ctxA(), 'del-basic', 'Northstar Robotics reported 4.2 crore in quarterly revenue.');
      const before = await withScopedTx(ctxA(), (tx) =>
        tx<{ n: number }[]>`select count(*)::int as n from content_chunks where page_id = ${page.pageId}`);
      expect(before[0]!.n).toBeGreaterThan(0);

      const result = await deletePage(ctxA(), { pageId: page.pageId });
      expect(result.pageId).toBe(page.pageId);
      expect(result.sourceRemoved).toBe(false);

      // Counted on the OWNER pool, not through RLS: a scoped count cannot distinguish "the chunks
      // are gone" from "the chunks are merely invisible to me now", and only one of those is the
      // claim being made. Soft delete (0014) means the ROW survives with deleted_at set, not that it
      // vanishes — real removal is scripts/purge-deleted.ts's job, after the grace window.
      const chunks = await adminSql()<{ deleted_at: Date | null }[]>`
        select deleted_at from content_chunks where page_id = ${page.pageId}`;
      expect(chunks.length, 'chunks are gone entirely — this is a hard delete again, not a soft one').toBeGreaterThan(0);
      for (const c of chunks) expect(c.deleted_at, 'a chunk survived its page delete without being marked').not.toBeNull();
    }, 120_000);

    it('reports sourceRemoved on the page that had a source, and its bytes survive until purge', async () => {
      const page = await seed(ctxA(), 'del-with-source', 'A page that also has its original bytes retained.');
      await withScopedTx(ctxA(), async (tx) => {
        const acl = (await tx<{ acl: string[] }[]>`select acl from pages where id = ${page.pageId}`)[0]!.acl;
        await tx`
          insert into page_sources (page_id, workspace_id, acl, filename, sha256, byte_len, bytes)
          values (${page.pageId}, ${ws1}, ${acl}, ${'orig.pdf'}, ${'a'.repeat(64)}, ${4}, ${Buffer.from('data')})`;
      });

      const result = await deletePage(ctxA(), { pageId: page.pageId });
      // The caller has to be told: this row is the only copy of the file (D71). Soft delete means the
      // bytes are not gone THIS INSTANT (page_sources has no deleted_at column of its own — nothing
      // reads it standalone today, and purge reaps it via the pages row's cascade) — sourceRemoved is
      // still true because that is the eventual, promised outcome, per its own doc comment.
      expect(result.sourceRemoved).toBe(true);
      const after = await adminSql()<{ n: number }[]>`
        select count(*)::int as n from page_sources where page_id = ${page.pageId}`;
      expect(after[0]!.n, 'page_sources was destroyed immediately — expected it to survive until purge').toBe(1);
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
      const still = await adminSql()<{ deleted_at: Date | null }[]>`select deleted_at from pages where id = ${page.pageId}`;
      expect(still, 'the page row is gone — this is a hard delete again, not a soft one').toHaveLength(1);
      expect(still[0]!.deleted_at).not.toBeNull();
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

  describe('soft delete (migration 0014)', () => {
    it('a deleted page disappears from get_page, list_pages, and a direct scoped SELECT', async () => {
      // The direct SELECT is the test that actually proves the RLS USING clause enforces this — not
      // just that the app-level op happens to 404. deletePage/getPage/listPages could all be broken
      // in a way that coincidentally agrees; a raw query under the author's own keyring cannot.
      const page = await seed(ctxA(), 'sd-basic', 'A page that will be soft-deleted.');
      await deletePage(ctxA(), { pageId: page.pageId });

      expect(await opCode(() => getPage(ctxA(), { pageId: page.pageId }))).toBe('not_found');
      const { pages } = await listPages(ctxA(), { limit: 200 });
      expect(pages.map((p) => p.id)).not.toContain(page.pageId);

      const direct = await withScopedTx(ctxA(), (tx) =>
        tx<{ id: string }[]>`select id from pages where id = ${page.pageId}`);
      expect(direct, 'RLS did not hide the soft-deleted row from a direct query').toHaveLength(0);
    }, 120_000);

    it('the row and its chunks SURVIVE on the admin pool, with deleted_at set — this is soft, not hard, delete', async () => {
      const page = await seed(ctxA(), 'sd-survives', 'A page whose row must still exist after delete.');
      await deletePage(ctxA(), { pageId: page.pageId });

      const pageRow = (await adminSql()<{ deleted_at: Date | null }[]>`
        select deleted_at from pages where id = ${page.pageId}`)[0];
      expect(pageRow, 'the page row is GONE — this is a hard delete, not a soft one').toBeDefined();
      expect(pageRow!.deleted_at).not.toBeNull();

      // Chunks are marked EXPLICITLY (UPDATE does not cascade the way the old hard DELETE did) — this
      // is the check that actually exercises that statement, distinct from the RLS check above.
      const chunkRows = await adminSql()<{ deleted_at: Date | null }[]>`
        select deleted_at from content_chunks where page_id = ${page.pageId}`;
      expect(chunkRows.length, 'no chunks found to check — the fixture produced none').toBeGreaterThan(0);
      for (const c of chunkRows) expect(c.deleted_at, 'a chunk was left live after its page was deleted').not.toBeNull();
    }, 120_000);

    it('a double-delete is not_found, not a redundant success', async () => {
      const page = await seed(ctxA(), 'sd-double', 'A page that will be deleted twice.');
      await deletePage(ctxA(), { pageId: page.pageId });
      // resolvePage can no longer see it (RLS), so the second call fails exactly like deleting a page
      // that never existed — same as the cross-tenant case, and for the same reason (D68's rule: not
      // distinguishing "gone" from "never was" is what keeps delete_page from being an existence oracle).
      expect(await opCode(() => deletePage(ctxA(), { pageId: page.pageId }))).toBe('not_found');
    }, 120_000);
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

  describe('get_page', () => {
    // Added with the op at M5 Phase 1. Until then there was NO way to read a page's text back
    // through the API — list_pages returns metadata only and search returns whichever fragments a
    // query matched — so a UI could show that a document existed and never show the document.
    it('returns the page metadata AND its reassembled text', async () => {
      const body = 'Clause one is about renewals. Clause two is about termination.';
      const seeded = await seed(ctxA(), 'gp-basic', body);
      const got = await getPage(ctxA(), { pageId: seeded.pageId });

      expect(got.id).toBe(seeded.pageId);
      expect(got.scope).toBe('workspace');
      expect(got.chunkCount).toBeGreaterThan(0);
      // Reassembled from chunks in ord order, because `pages` has no body column — chunks ARE the
      // storage. So this asserts the text survives the round trip, not that a column was echoed.
      expect(got.content).toContain('Clause one');
      expect(got.content).toContain('Clause two');
    });

    it('addresses by slug as well as by id, and refuses both or neither', async () => {
      await seed(ctxA(), 'gp-by-slug', 'Addressed by slug.');
      const bySlug = await getPage(ctxA(), { slug: `gp-by-slug-${RUN}` });
      expect(bySlug.content).toContain('Addressed by slug');

      expect(await opCode(() => getPage(ctxA(), {}))).toBe('invalid_params');
      expect(await opCode(() => getPage(ctxA(), { pageId: crypto.randomUUID(), slug: 'x' }))).toBe(
        'invalid_params',
      );
    });

    it('cannot read a page in another tenant, even with its exact id', async () => {
      // The strongest form of the question: workspace 2 knows the id and asks for it directly.
      // RLS is what refuses, not an app-layer check — resolvePage simply finds no row.
      const other = await seed(ctxC(), 'gp-other-tenant', 'Another tenant only.');
      expect(await opCode(() => getPage(ctxA(), { pageId: other.pageId }))).toBe('not_found');
    });

    it('does not expose a colleague private page to another member of the same workspace', async () => {
      // Same workspace, different principal: the acl half of the policy is what filters here, and
      // it is the half that workspace-equality alone would not catch.
      const priv = await seed(ctxA(), 'gp-private', 'Only A may read this.', 'private');
      expect(await opCode(() => getPage(ctxB(), { pageId: priv.pageId }))).toBe('not_found');
    });
  });

});

// ── get_page must return the DOCUMENT, not a reassembly of overlapping chunks ────────────────
//
// Offline and deliberately so: every live get_page case above seeds a single-chunk body, which is
// exactly why this shipped. Chunks overlap by construction, so joining them duplicates text at every
// boundary — and with one chunk there is no boundary. This proves the property with arithmetic
// instead of a database.
describe('get_page returns authoritative text, not rejoined chunks', () => {
  it('rejoining chunks DUPLICATES the overlap window — which is why getPage must not', async () => {
    const { chunkText } = await import('../src/ingest/chunk.ts');
    // 700 words forces more than one chunk at the default size/overlap.
    const words = Array.from({ length: 700 }, (_, i) => `w${i}`);
    const chunks = chunkText(words.join(' '));
    expect(chunks.length, 'one chunk means no boundary and this test proves nothing').toBeGreaterThan(1);
    const rejoined = chunks.map((c) => c.text).join('\n\n');
    // Measured: 700 words in, 750 out. The naive join is lossy in the ADDING direction.
    expect(rejoined.split(/\s+/).length).toBeGreaterThan(words.length);
  });

  it('getPage reads the stored text columns, not content_chunks, on the primary path', async () => {
    // Source scan, because the alternative needs a live multi-chunk page. The claim it pins is that
    // the primary path selects the authoritative columns; the chunk join survives only as the
    // pre-0009 fallback, below the early return.
    const src = await Bun.file(new URL('../src/ingest/lifecycle.ts', import.meta.url)).text();
    const at = src.indexOf('export async function getPage');
    expect(at, 'getPage is gone — this scan reads nothing').toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('\n}', at));
    expect(body).toContain('coalesce(p.body, p.extracted_text)');
    // The old justification was a comment claiming pages has no body column. It has two.
    const schema = await Bun.file(new URL('../src/db/schema.sql', import.meta.url)).text();
    expect(schema, 'pages.body is gone — the fix rests on a column that no longer exists').toMatch(/^\s*body\s+text,/m);
    // extracted_text is added by migration 0009, not by the M0 baseline — check where it lives.
    const m0009 = await Bun.file(new URL('../src/db/migrations/0009_multiformat.sql', import.meta.url)).text();
    expect(m0009, 'pages.extracted_text is gone — file-sourced pages lose their authoritative text')
      .toMatch(/ADD COLUMN extracted_text/);
    // And the chunk join must sit AFTER the authoritative return, not before it.
    const join = body.indexOf("rows.map((r) => r.content).join");
    const authoritative = body.indexOf('if (m.text !== null) return');
    expect(join).toBeGreaterThan(authoritative);
  });

  it('the read is BOUNDED, and a truncated read says so', async () => {
    const { MAX_PAGE_CONTENT_CHARS } = await import('../src/ingest/lifecycle.ts');
    expect(MAX_PAGE_CONTENT_CHARS).toBeGreaterThan(0);
    const src = await Bun.file(new URL('../src/ingest/lifecycle.ts', import.meta.url)).text();
    // Truncation in SQL, so an oversized document never lands in this process's heap.
    expect(src).toContain('left(coalesce(p.body, p.extracted_text)');
    expect(src).toMatch(/truncated: boolean/);
  });

  it('getPage issues ONE statement on the primary path', async () => {
    // It used to run three, the third recomputing a count over chunks it had already fetched.
    const src = await Bun.file(new URL('../src/ingest/lifecycle.ts', import.meta.url)).text();
    const at = src.indexOf('export async function getPage');
    const body = src.slice(at, src.indexOf('\n}', at));
    const beforeReturn = body.slice(0, body.indexOf('if (m.text !== null) return'));
    // ONE. It used to be two here (chunk read, then a second read of the same page row) on top of
    // resolvePage. The chunk_count subquery inside this one statement is NOT the waste — with the
    // chunks no longer fetched it is the only way to know the number, and it costs no round trip.
    expect([...beforeReturn.matchAll(/await tx</g)].length).toBe(1);
    expect(beforeReturn, 'the separate chunk read came back').not.toContain('select content from content_chunks');
  });
});
