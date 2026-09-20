// Security/lifecycle regression coverage for migration 0022. Every visibility assertion uses
// withScopedTx: adminSql is BYPASSRLS and may inspect physical/denormalized state only.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { liveOrFail, hasDbEnv } from './helpers/live.ts';
import { installFakeAiFetch } from './helpers/fake-ai.ts';
import { adminSql, closePools, withScopedTx } from '../src/db/client.ts';
import { buildContext, resolveGrants, wsGrant, type OperationContext } from '../src/core/context.ts';
import { buildCycleContext } from '../src/core/cycle/lock.ts';
import { importPage } from '../src/ingest/import.ts';
import { deletePage, rescopePages } from '../src/ingest/lifecycle.ts';
import { config } from '../src/config.ts';

const RUN = crypto.randomUUID().slice(0, 8);
const live = liveOrFail('links', hasDbEnv());
const mutableConfig = config as unknown as Record<string, unknown>;

describe.skipIf(!live)('links security hardening (M9/0022) — live', () => {
  let workspaceId = '';
  let otherWorkspaceId = '';
  let ownerId = '';
  let memberId = '';
  let otherOwnerId = '';
  let ownerCtx: OperationContext;
  let memberCtx: OperationContext;
  const realFetch = globalThis.fetch;
  const realKey = mutableConfig.OPENAI_API_KEY;

  const edgeRows = (ctx: OperationContext, fromId: string, toId: string) =>
    withScopedTx(ctx, (tx) => tx<{ id: string }[]>`
      select id from links where from_page_id = ${fromId} and to_page_id = ${toId}`);

  const makeEdge = async (tag: string) => {
    const target = await importPage(ownerCtx, {
      slug: `security-target-${tag}-${RUN}-${crypto.randomUUID().slice(0, 6)}`,
      title: `Security Target ${tag} ${RUN} ${crypto.randomUUID().slice(0, 6)}`,
      body: 'Target body.',
    });
    const targetTitle = (await adminSql()<{ title: string }[]>`
      select title from pages where id = ${target.pageId}`)[0]!.title;
    const source = await importPage(ownerCtx, {
      slug: `security-source-${tag}-${RUN}-${crypto.randomUUID().slice(0, 6)}`,
      title: `Security Source ${tag}`,
      body: `This source names ${targetTitle} directly.`,
    });
    expect(await edgeRows(ownerCtx, source.pageId, target.pageId)).toHaveLength(1);
    return { sourceId: source.pageId, targetId: target.pageId };
  };

  beforeAll(async () => {
    mutableConfig.OPENAI_API_KEY = 'test-key';
    globalThis.fetch = installFakeAiFetch();

    const admin = adminSql();
    const principal = async (tag: string) =>
      (await admin<{ id: string }[]>`
        insert into principals (email, email_normalized)
        values (${`links-security-${tag}-${RUN}@example.com`}, ${`links-security-${tag}-${RUN}@example.com`})
        returning id`)[0]!.id;
    ownerId = await principal('owner');
    memberId = await principal('member');
    otherOwnerId = await principal('other');
    workspaceId = (await admin<{ id: string }[]>`
      insert into workspaces (name, created_by) values (${`links-security-${RUN}`}, ${ownerId}) returning id`)[0]!.id;
    otherWorkspaceId = (await admin<{ id: string }[]>`
      insert into workspaces (name, created_by) values (${`links-security-other-${RUN}`}, ${otherOwnerId}) returning id`)[0]!.id;
    await admin`
      insert into workspace_members (workspace_id, principal_id, role) values
        (${workspaceId}, ${ownerId}, 'owner'),
        (${workspaceId}, ${memberId}, 'member'),
        (${otherWorkspaceId}, ${otherOwnerId}, 'owner')`;

    ownerCtx = buildContext({
      principal: ownerId,
      workspaceId,
      role: 'owner',
      grants: resolveGrants(ownerId, workspaceId),
      remote: false,
    });
    memberCtx = buildContext({
      principal: memberId,
      workspaceId,
      role: 'member',
      grants: resolveGrants(memberId, workspaceId),
      remote: false,
    });
  }, 120_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    mutableConfig.OPENAI_API_KEY = realKey;
    const admin = adminSql();
    await admin`delete from workspaces where id in (${workspaceId}, ${otherWorkspaceId})`;
    await admin`delete from principals where id in (${ownerId}, ${memberId}, ${otherOwnerId})`;
    await closePools({ timeout: 5 });
  }, 60_000);

  it('source rescope synchronizes outgoing ACL state in both directions', async () => {
    const { sourceId, targetId } = await makeEdge('source-rescope');
    expect(await edgeRows(memberCtx, sourceId, targetId)).toHaveLength(1);

    expect((await rescopePages(ownerCtx, [sourceId], 'private')).rescoped).toBe(1);
    expect(await edgeRows(memberCtx, sourceId, targetId)).toHaveLength(0);
    const [privateEdge] = await adminSql()<{
      from_acl: string[]; page_acl: string[];
    }[]>`
      select l.from_acl, p.acl as page_acl from links l
      join pages p on p.id = l.from_page_id
      where l.from_page_id = ${sourceId} and l.to_page_id = ${targetId}`;
    expect(privateEdge?.from_acl).toEqual(privateEdge?.page_acl);

    expect((await rescopePages(ownerCtx, [sourceId], 'workspace')).rescoped).toBe(1);
    expect(await edgeRows(memberCtx, sourceId, targetId)).toHaveLength(1);
  }, 120_000);

  it('target rescope synchronizes incoming ACL state in both directions', async () => {
    const { sourceId, targetId } = await makeEdge('target-rescope');
    expect(await edgeRows(memberCtx, sourceId, targetId)).toHaveLength(1);

    expect((await rescopePages(ownerCtx, [targetId], 'private')).rescoped).toBe(1);
    expect(await edgeRows(memberCtx, sourceId, targetId)).toHaveLength(0);
    const [privateEdge] = await adminSql()<{
      to_acl: string[]; page_acl: string[];
    }[]>`
      select l.to_acl, p.acl as page_acl from links l
      join pages p on p.id = l.to_page_id
      where l.from_page_id = ${sourceId} and l.to_page_id = ${targetId}`;
    expect(privateEdge?.to_acl).toEqual(privateEdge?.page_acl);

    expect((await rescopePages(ownerCtx, [targetId], 'workspace')).rescoped).toBe(1);
    expect(await edgeRows(memberCtx, sourceId, targetId)).toHaveLength(1);
  }, 120_000);

  it('direct scoped SELECT hides a raw edge when its source is soft-deleted', async () => {
    const { sourceId, targetId } = await makeEdge('source-delete');
    expect(await edgeRows(ownerCtx, sourceId, targetId)).toHaveLength(1);
    await deletePage(ownerCtx, { pageId: sourceId });
    expect(await edgeRows(ownerCtx, sourceId, targetId)).toHaveLength(0);

    const [physical] = await adminSql()<{
      n: number; from_deleted_at: Date | null;
    }[]>`
      select count(*)::int as n, max(from_deleted_at) as from_deleted_at
      from links where from_page_id = ${sourceId} and to_page_id = ${targetId}`;
    expect(physical?.n).toBe(1);
    expect(physical?.from_deleted_at).not.toBeNull();
  }, 120_000);

  it('direct scoped SELECT hides a raw edge when its target is soft-deleted', async () => {
    const { sourceId, targetId } = await makeEdge('target-delete');
    expect(await edgeRows(ownerCtx, sourceId, targetId)).toHaveLength(1);
    await deletePage(ownerCtx, { pageId: targetId });
    expect(await edgeRows(ownerCtx, sourceId, targetId)).toHaveLength(0);

    const [physical] = await adminSql()<{
      n: number; to_deleted_at: Date | null;
    }[]>`
      select count(*)::int as n, max(to_deleted_at) as to_deleted_at
      from links where from_page_id = ${sourceId} and to_page_id = ${targetId}`;
    expect(physical?.n).toBe(1);
    expect(physical?.to_deleted_at).not.toBeNull();
  }, 120_000);

  it('canonicalizes spoofed endpoint security fields and cb_app cannot UPDATE links', async () => {
    const privateTarget = await importPage(ownerCtx, {
      slug: `spoof-target-${RUN}`,
      title: `Spoof Target ${RUN}`,
      body: 'private target',
      scope: 'private',
    });
    const privateSource = await importPage(ownerCtx, {
      slug: `spoof-source-${RUN}`,
      title: `Spoof Source ${RUN}`,
      body: 'private source with no extracted reference',
      scope: 'private',
    });

    const inserted = await withScopedTx(ownerCtx, (tx) => tx<{ id: string }[]>`
      insert into links (
        workspace_id, from_page_id, to_page_id, from_acl, to_acl,
        link_kind, link_source, context, from_deleted_at, to_deleted_at
      ) values (
        ${otherWorkspaceId}, ${privateSource.pageId}, ${privateTarget.pageId},
        ${[]}::text[], ${[]}::text[], 'mention', ${`spoof-${RUN}`}, 'spoof', now(), now()
      ) returning id`);
    expect(inserted).toHaveLength(1);
    const insertedId = inserted[0]!.id;

    const [canonical] = await adminSql()<{
      workspace_id: string; from_acl: string[]; to_acl: string[];
      from_deleted_at: Date | null; to_deleted_at: Date | null;
    }[]>`
      select workspace_id, from_acl, to_acl, from_deleted_at, to_deleted_at
      from links where id = ${insertedId}`;
    expect(canonical?.workspace_id).toBe(workspaceId);
    expect(canonical?.from_acl).toEqual([`self:${ownerId.toLowerCase()}`]);
    expect(canonical?.to_acl).toEqual([`self:${ownerId.toLowerCase()}`]);
    expect(canonical?.from_deleted_at).toBeNull();
    expect(canonical?.to_deleted_at).toBeNull();

    await expect(withScopedTx(ownerCtx, (tx) => tx`
      update links set context = 'rewritten' where id = ${insertedId}`)).rejects.toMatchObject({ code: '42501' });
  }, 120_000);

  it('non-sentinel callers cannot invoke cycle definers or use the cycle policy', async () => {
    const privateTarget = await importPage(ownerCtx, {
      slug: `non-system-private-${RUN}`,
      title: `Non System Private ${RUN}`,
      body: 'private',
      scope: 'private',
    });
    const sharedSource = await importPage(ownerCtx, {
      slug: `non-system-shared-${RUN}`,
      title: `Non System Shared ${RUN}`,
      body: 'shared without an extracted reference',
    });

    await expect(withScopedTx(memberCtx, (tx) => tx`
      select * from cb_internal.cycle_link_pages(null, 10)`)).rejects.toMatchObject({ code: '42501' });
    await expect(withScopedTx(memberCtx, (tx) => tx`
      select * from cb_internal.cycle_lock_link_sources(${[sharedSource.pageId]}::uuid[])`)).rejects.toMatchObject({ code: '42501' });
    await expect(withScopedTx(memberCtx, (tx) => tx`
      select * from cb_internal.cycle_link_page_acls(${[privateTarget.pageId]}::uuid[])`)).rejects.toMatchObject({ code: '42501' });

    // The caller supplies workspace ACLs, but the canonicalizing trigger replaces them with the
    // private target ACL before WITH CHECK. links_ws then rejects, and links_cycle_system is false.
    await expect(withScopedTx(memberCtx, (tx) => tx`
      insert into links (
        workspace_id, from_page_id, to_page_id, from_acl, to_acl,
        link_kind, link_source, context
      ) values (
        ${workspaceId}, ${sharedSource.pageId}, ${privateTarget.pageId},
        ${[wsGrant(workspaceId)]}, ${[wsGrant(workspaceId)]},
        'mention', ${`non-system-${RUN}`}, 'must not land'
      )`)).rejects.toMatchObject({ code: '42501' });
  }, 120_000);

  it('the cycle sentinel can snapshot, lock, and reconcile private pages only inside its workspace', async () => {
    const privateTarget = await importPage(ownerCtx, {
      slug: `cycle-private-target-${RUN}`,
      title: `Cycle Private Target ${RUN}`,
      body: 'private target',
      scope: 'private',
    });
    const privateSource = await importPage(ownerCtx, {
      slug: `cycle-private-source-${RUN}`,
      title: `Cycle Private Source ${RUN}`,
      body: 'private source without an extracted reference',
      scope: 'private',
    });
    const cycleCtx = buildCycleContext(workspaceId);

    const inserted = await withScopedTx(cycleCtx, async (tx) => {
      const snapshot = await tx<{ id: string }[]>`
        select id from cb_internal.cycle_link_pages(null, 1000)`;
      expect(snapshot.some((p) => p.id === privateSource.pageId)).toBe(true);

      const sources = await tx<{ id: string; acl: string[]; body: string | null; extracted_text: string | null }[]>`
        select * from cb_internal.cycle_lock_link_sources(${[privateSource.pageId]}::uuid[])`;
      expect(sources[0]?.acl).toEqual([`self:${ownerId.toLowerCase()}`]);
      expect(sources[0]?.body).toContain('private source');

      const targets = await tx<{ id: string; acl: string[] }[]>`
        select * from cb_internal.cycle_link_page_acls(${[privateTarget.pageId]}::uuid[])`;
      expect(targets[0]?.acl).toEqual([`self:${ownerId.toLowerCase()}`]);

      return tx<{ id: string }[]>`
        insert into links (
          workspace_id, from_page_id, to_page_id, from_acl, to_acl,
          link_kind, link_source, context
        ) values (
          ${workspaceId}, ${privateSource.pageId}, ${privateTarget.pageId},
          ${[wsGrant(workspaceId)]}, ${[wsGrant(workspaceId)]},
          'mention', ${`cycle-private-${RUN}`}, 'private cycle edge'
        ) returning id`;
    });
    expect(inserted).toHaveLength(1);
    expect(await edgeRows(ownerCtx, privateSource.pageId, privateTarget.pageId)).toHaveLength(1);
    expect(await edgeRows(memberCtx, privateSource.pageId, privateTarget.pageId)).toHaveLength(0);

    const otherCycleCtx = buildCycleContext(otherWorkspaceId);
    const crossWorkspace = await withScopedTx(otherCycleCtx, (tx) => tx<{ id: string }[]>`
      select id from cb_internal.cycle_link_pages(null, 1000)
      where id in (${privateSource.pageId}, ${privateTarget.pageId})`);
    expect(crossWorkspace).toHaveLength(0);
  }, 120_000);
});
