// Regression for M9's empty-initial-state race. A DELETE cannot serialize two reconciliations when
// there is no outgoing link row to lock, so both transactions must instead lock the stable source
// page before they discover candidates or replace edges.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { liveOrFail, hasDbEnv } from './helpers/live.ts';
import { adminSql, closePools, withScopedTx } from '../src/db/client.ts';
import { buildContext, resolveGrants, wsGrant, type OperationContext } from '../src/core/context.ts';
import { extractAndReconcileLinks } from '../src/core/links/reconcile.ts';

const live = liveOrFail('links-reconcile-concurrency', hasDbEnv());
const RUN = crypto.randomUUID().slice(0, 8);

describe.skipIf(!live)('link reconciliation serialization — live', () => {
  let principalId = '';
  let workspaceId = '';
  let sourceId = '';
  let targetId = '';

  const ctx = (): OperationContext => buildContext({
    principal: principalId,
    workspaceId,
    role: 'owner',
    grants: resolveGrants(principalId, workspaceId),
    remote: false,
  });

  beforeAll(async () => {
    const admin = adminSql();
    const email = `links-race-${RUN}@ex.com`;
    principalId = (await admin<{ id: string }[]>`
      insert into principals (email, email_normalized)
      values (${email}, ${email})
      returning id`)[0]!.id;
    workspaceId = (await admin<{ id: string }[]>`
      insert into workspaces (name, created_by)
      values (${`links-race-${RUN}`}, ${principalId})
      returning id`)[0]!.id;
    await admin`
      insert into workspace_members (workspace_id, principal_id, role)
      values (${workspaceId}, ${principalId}, 'owner')`;

    const acl = [wsGrant(workspaceId)];
    const pages = await admin<{ id: string; slug: string }[]>`
      insert into pages (workspace_id, slug, title, owner_principal, scope, acl, body)
      values
        (${workspaceId}, ${`race-source-${RUN}`}, ${`Race Source ${RUN}`},
          ${principalId}, 'workspace', ${acl}, 'No outgoing mention yet.'),
        (${workspaceId}, ${`race-target-${RUN}`}, ${`Race Target ${RUN}`},
          ${principalId}, 'workspace', ${acl}, 'Target body.')
      returning id, slug`;
    sourceId = pages.find((page) => page.slug === `race-source-${RUN}`)!.id;
    targetId = pages.find((page) => page.slug === `race-target-${RUN}`)!.id;
  });

  afterAll(async () => {
    const admin = adminSql();
    await admin`delete from workspaces where id = ${workspaceId}`;
    await admin`delete from principals where id = ${principalId}`;
    await closePools({ timeout: 5 });
  });

  it('serializes two first-time reconciliations of the same source with no link row to lock', async () => {
    const before = await withScopedTx(ctx(), (tx) => tx<{ id: string }[]>`
      select id from links where from_page_id = ${sourceId}`);
    expect(before, 'the race must begin with no DELETE-able link row').toHaveLength(0);

    const reconcile = () => withScopedTx(ctx(), (tx) => extractAndReconcileLinks(tx, {
      workspaceId,
      pageId: sourceId,
      pageAcl: ['caller input is deliberately ignored'],
      text: `See Race Target ${RUN}.`,
    }));

    await expect(Promise.all([reconcile(), reconcile()])).resolves.toEqual([
      { linksWritten: 1 },
      { linksWritten: 1 },
    ]);

    const after = await withScopedTx(ctx(), (tx) => tx<{ to_page_id: string }[]>`
      select to_page_id from links where from_page_id = ${sourceId}`);
    expect([...after]).toEqual([{ to_page_id: targetId }]);
  }, 120_000);
});
