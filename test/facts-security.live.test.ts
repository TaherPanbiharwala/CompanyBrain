// Security/lifecycle regression coverage for migration 0023 (M10 wave 1 sub-step A). Every
// visibility assertion uses withScopedTx: adminSql is BYPASSRLS and may inspect physical/denormalized
// state only. Mirrors test/links-security.live.test.ts's shape, adapted for facts' single-parent RLS
// (facts_ws is SELECT-only; facts_cycle_system is INSERT-only; facts_rescope is UPDATE-only) rather
// than links' two-endpoint trigger-canonicalized shape.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { liveOrFail, hasDbEnv } from './helpers/live.ts';
import { adminSql, closePools, withScopedTx } from '../src/db/client.ts';
import { buildContext, resolveGrants, type OperationContext } from '../src/core/context.ts';
import { buildCycleContext } from '../src/core/cycle/lock.ts';
import { importPage } from '../src/ingest/import.ts';
import { deletePage, rescopePages } from '../src/ingest/lifecycle.ts';

const RUN = crypto.randomUUID().slice(0, 8);
const live = liveOrFail('facts', hasDbEnv());

describe.skipIf(!live)('facts security (M10 wave 1 sub-step A / 0023) — live', () => {
  let workspaceId = '';
  let otherWorkspaceId = '';
  let ownerId = '';
  let memberId = '';
  let otherOwnerId = '';
  let ownerCtx: OperationContext;
  let memberCtx: OperationContext;
  let otherOwnerCtx: OperationContext;

  const factRows = (ctx: OperationContext, pageId: string) =>
    withScopedTx(ctx, (tx) => tx<{ id: string; claim_text: string }[]>`
      select id, claim_text from facts where source_page_id = ${pageId}`);

  /** Simulates what FactExtractionPhase writes, without the LLM call — a direct INSERT under the
   *  cycle sentinel's context, exactly like links-security.live.test.ts's own cycle-INSERT tests.
   *
   *  Deliberately NO `returning id` on the scoped INSERT itself, and this is not a style choice: for
   *  a PRIVATE page, the sentinel's own grants (workspace-only) do not overlap that page's
   *  `self:<owner>` acl, so the just-inserted row would be invisible under facts_ws's SELECT policy —
   *  and RETURNING requires that same visibility, the identical intrinsic-RLS property documented on
   *  soft_delete_page in migrate.ts ("an UPDATE's new row must remain visible under the table's
   *  SELECT-governing policies"). The production phase never hits this (its own bulk INSERT has no
   *  RETURNING), but this test helper wants the id back, so it reads it via adminSql (BYPASSRLS)
   *  instead, exactly like the rest of this file already reads physical state. */
  const insertFact = async (pageId: string, claimText: string) => {
    const page = (await adminSql()<{ acl: string[] }[]>`select acl from pages where id = ${pageId}`)[0]!;
    const runId = crypto.randomUUID();
    const cycleCtx = buildCycleContext(workspaceId);
    await withScopedTx(cycleCtx, (tx) => tx`
      insert into facts (workspace_id, source_page_id, acl, kind, notability, confidence, claim_text, source_excerpt, extracted_by_run_id)
      values (${workspaceId}, ${pageId}, ${page.acl}, 'fact', 'medium', 1.0, ${claimText}, '', ${runId})`);
    const [row] = await adminSql()<{ id: string }[]>`
      select id from facts where source_page_id = ${pageId} and extracted_by_run_id = ${runId}`;
    return row!.id;
  };

  beforeAll(async () => {
    const admin = adminSql();
    const principal = async (tag: string) =>
      (await admin<{ id: string }[]>`
        insert into principals (email, email_normalized)
        values (${`facts-security-${tag}-${RUN}@example.com`}, ${`facts-security-${tag}-${RUN}@example.com`})
        returning id`)[0]!.id;
    ownerId = await principal('owner');
    memberId = await principal('member');
    otherOwnerId = await principal('other');
    workspaceId = (await admin<{ id: string }[]>`
      insert into workspaces (name, created_by) values (${`facts-security-${RUN}`}, ${ownerId}) returning id`)[0]!.id;
    otherWorkspaceId = (await admin<{ id: string }[]>`
      insert into workspaces (name, created_by) values (${`facts-security-other-${RUN}`}, ${otherOwnerId}) returning id`)[0]!.id;
    await admin`
      insert into workspace_members (workspace_id, principal_id, role) values
        (${workspaceId}, ${ownerId}, 'owner'),
        (${workspaceId}, ${memberId}, 'member'),
        (${otherWorkspaceId}, ${otherOwnerId}, 'owner')`;

    ownerCtx = buildContext({
      principal: ownerId, workspaceId, role: 'owner', grants: resolveGrants(ownerId, workspaceId), remote: false,
    });
    memberCtx = buildContext({
      principal: memberId, workspaceId, role: 'member', grants: resolveGrants(memberId, workspaceId), remote: false,
    });
    otherOwnerCtx = buildContext({
      principal: otherOwnerId, workspaceId: otherWorkspaceId, role: 'owner',
      grants: resolveGrants(otherOwnerId, otherWorkspaceId), remote: false,
    });
  }, 120_000);

  afterAll(async () => {
    const admin = adminSql();
    await admin`delete from workspaces where id in (${workspaceId}, ${otherWorkspaceId})`;
    await admin`delete from principals where id in (${ownerId}, ${memberId}, ${otherOwnerId})`;
    await closePools({ timeout: 5 });
  }, 60_000);

  it('a two-phase oracle: the owner sees their own workspace-scoped fact first, then an outside principal sees nothing', async () => {
    const page = await importPage(ownerCtx, {
      slug: `fact-oracle-${RUN}`, title: `Fact Oracle ${RUN}`, body: 'MRR grew to $40k in Q3.',
    });
    const factId = await insertFact(page.pageId, 'MRR grew to $40k in Q3.');

    // Positive control FIRST: prove the owner within the workspace can see it before asserting anyone
    // cannot — a one-phase "B sees nothing" sweep is vacuous (it would also pass if RLS hid the row
    // from EVERYONE, including its own workspace).
    const ownerView = await factRows(ownerCtx, page.pageId);
    expect(ownerView.map((r) => r.id)).toContain(factId);

    const memberView = await factRows(memberCtx, page.pageId);
    expect(memberView.map((r) => r.id)).toContain(factId);

    const outsideView = await factRows(otherOwnerCtx, page.pageId);
    expect(outsideView).toHaveLength(0);
  }, 120_000);

  it('a private page (self-only acl) is invisible to a workspace colleague', async () => {
    const page = await importPage(ownerCtx, {
      slug: `fact-private-${RUN}`, title: `Fact Private ${RUN}`, body: 'private content', scope: 'private',
    });
    const factId = await insertFact(page.pageId, 'a private claim');

    expect((await factRows(ownerCtx, page.pageId)).map((r) => r.id)).toContain(factId);
    expect(await factRows(memberCtx, page.pageId)).toHaveLength(0);
  }, 120_000);

  it('a fact whose source page is soft-deleted is hidden via facts_hide_deleted', async () => {
    const page = await importPage(ownerCtx, {
      slug: `fact-source-delete-${RUN}`, title: `Fact Source Delete ${RUN}`, body: 'will be deleted',
    });
    const factId = await insertFact(page.pageId, 'a claim about a soon-deleted page');
    expect((await factRows(ownerCtx, page.pageId)).map((r) => r.id)).toContain(factId);

    await deletePage(ownerCtx, { pageId: page.pageId });
    expect(await factRows(ownerCtx, page.pageId)).toHaveLength(0);

    const [physical] = await adminSql()<{ n: number; deleted_at: Date | null }[]>`
      select count(*)::int as n, max(deleted_at) as deleted_at from facts where id = ${factId}`;
    expect(physical?.n).toBe(1);
    expect(physical?.deleted_at).not.toBeNull();
  }, 120_000);

  it('rescopePages syncs facts.acl to match the page, in the same batch as content_chunks', async () => {
    const page = await importPage(ownerCtx, {
      slug: `fact-rescope-${RUN}`, title: `Fact Rescope ${RUN}`, body: 'rescope target',
    });
    const factId = await insertFact(page.pageId, 'a claim that should follow its page');
    expect((await factRows(memberCtx, page.pageId)).map((r) => r.id)).toContain(factId);

    expect((await rescopePages(ownerCtx, [page.pageId], 'private')).rescoped).toBe(1);
    expect(await factRows(memberCtx, page.pageId)).toHaveLength(0);
    expect((await factRows(ownerCtx, page.pageId)).map((r) => r.id)).toContain(factId);

    const [row] = await adminSql()<{ fact_acl: string[]; page_acl: string[] }[]>`
      select f.acl as fact_acl, p.acl as page_acl from facts f
      join pages p on p.id = f.source_page_id where f.id = ${factId}`;
    expect(row?.fact_acl).toEqual(row?.page_acl);

    expect((await rescopePages(ownerCtx, [page.pageId], 'workspace')).rescoped).toBe(1);
    expect((await factRows(memberCtx, page.pageId)).map((r) => r.id)).toContain(factId);
  }, 120_000);

  it('an ordinary member cannot INSERT a fact directly, even with a self-satisfying acl', async () => {
    const page = await importPage(ownerCtx, {
      slug: `fact-no-insert-${RUN}`, title: `Fact No Insert ${RUN}`, body: 'no ordinary insert path',
    });
    // facts_ws covers SELECT only; facts_cycle_system covers INSERT but requires the sentinel
    // principal. No permissive INSERT policy applies to an ordinary member, even though cb_app holds
    // the table-level INSERT grant (GRANT is per-role; the sentinel and this member share cb_app).
    await expect(withScopedTx(memberCtx, (tx) => tx`
      insert into facts (workspace_id, source_page_id, acl, claim_text, source_excerpt, extracted_by_run_id)
      values (${workspaceId}, ${page.pageId}, ${[`ws:${workspaceId}`]}, 'fabricated claim', '', ${crypto.randomUUID()})
    `)).rejects.toMatchObject({ code: '42501' });
  }, 120_000);

  it('an ordinary member cannot UPDATE claim_text, even on a fact they can see (acl is the only writable column)', async () => {
    const page = await importPage(ownerCtx, {
      slug: `fact-no-rewrite-${RUN}`, title: `Fact No Rewrite ${RUN}`, body: 'rewrite target',
    });
    const factId = await insertFact(page.pageId, 'the real claim');
    expect((await factRows(memberCtx, page.pageId)).map((r) => r.id)).toContain(factId);

    await expect(withScopedTx(memberCtx, (tx) => tx`
      update facts set claim_text = 'rewritten' where id = ${factId}
    `)).rejects.toMatchObject({ code: '42501' });

    const [row] = await adminSql()<{ claim_text: string }[]>`select claim_text from facts where id = ${factId}`;
    expect(row?.claim_text).toBe('the real claim');
  }, 120_000);

  it('non-sentinel callers cannot invoke any of the three fact-extraction cycle definers', async () => {
    const page = await importPage(ownerCtx, {
      slug: `fact-non-system-${RUN}`, title: `Fact Non System ${RUN}`, body: 'x'.repeat(100),
    });
    await expect(withScopedTx(memberCtx, (tx) => tx`
      select * from cb_internal.cycle_fact_extraction_candidates(null, 10)`)).rejects.toMatchObject({ code: '42501' });
    await expect(withScopedTx(memberCtx, (tx) => tx`
      select cb_internal.cycle_write_fact_extraction_stamp(${page.pageId}, 'deadbeef')`)).rejects.toMatchObject({ code: '42501' });
    await expect(withScopedTx(memberCtx, (tx) => tx`
      select * from cb_internal.cycle_facts_by_entity('some-entity', ${'[' + new Array(1536).fill(0).join(',') + ']'}::vector, 5)`))
      .rejects.toMatchObject({ code: '42501' });
  }, 120_000);

  it('the cycle sentinel of another workspace cannot see or extract-candidate this workspace\'s pages', async () => {
    const page = await importPage(ownerCtx, {
      slug: `fact-cross-tenant-${RUN}`, title: `Fact Cross Tenant ${RUN}`, body: 'x'.repeat(100),
    });
    const otherCycleCtx = buildCycleContext(otherWorkspaceId);
    const crossWorkspace = await withScopedTx(otherCycleCtx, (tx) => tx<{ id: string }[]>`
      select id from cb_internal.cycle_fact_extraction_candidates(null, 1000)
      where id = ${page.pageId}`);
    expect(crossWorkspace).toHaveLength(0);
  }, 120_000);

  it('the sentinel candidate reader skips a page already stamped with its current content_hash', async () => {
    const page = await importPage(ownerCtx, {
      slug: `fact-skip-stamped-${RUN}`, title: `Fact Skip Stamped ${RUN}`, body: 'stable content',
    });
    const cycleCtx = buildCycleContext(workspaceId);

    const beforeStamp = await withScopedTx(cycleCtx, (tx) => tx<{ id: string }[]>`
      select id from cb_internal.cycle_fact_extraction_candidates(null, 1000) where id = ${page.pageId}`);
    expect(beforeStamp).toHaveLength(1);

    const [pageHash] = await adminSql()<{ content_hash: string }[]>`
      select content_hash from pages where id = ${page.pageId}`;
    // The page was just created above, so absence is a test setup failure rather than an optional
    // property. Narrow explicitly instead of destructuring an array element TypeScript correctly
    // considers possibly undefined.
    if (!pageHash) throw new Error('fresh page missing from admin lookup');
    const { content_hash } = pageHash;
    await withScopedTx(cycleCtx, (tx) => tx`
      select cb_internal.cycle_write_fact_extraction_stamp(${page.pageId}, ${content_hash})`);

    const afterStamp = await withScopedTx(cycleCtx, (tx) => tx<{ id: string }[]>`
      select id from cb_internal.cycle_fact_extraction_candidates(null, 1000) where id = ${page.pageId}`);
    expect(afterStamp).toHaveLength(0);
  }, 120_000);
});
