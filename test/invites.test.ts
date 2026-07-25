// createInvite — the role ceiling, and the token/hash contract.
//
// This file exists because the M2 review found `createInvite` had been written with a comment
// claiming "it has its own test for that reason", registered as no operation, reachable from no
// route, and referenced by no test. The escalation guard it describes — an admin must not be able to
// mint an OWNER invite and then redeem it — had therefore never executed once.
//
// It matters more than a typical app-layer check: narrowGrants leaves cb_app holding table-level
// INSERT on `invites`, so NOTHING in the database prevents an `invites.role = 'owner'` row. This
// function is the only thing standing there.
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { adminSql, appSql, withScopedTx, closePools } from '../src/db/client.ts';
import { buildContext, resolveGrants } from '../src/core/context.ts';
import { createInvite } from '../src/auth/invites.ts';
import { hashToken, TOKEN_LENGTH } from '../src/auth/session.ts';
import { normalizeEmail } from '../src/auth/normalize.ts';
import { liveOrFail, hasDbEnv } from './helpers/live.ts';

const RUN = crypto.randomUUID().slice(0, 8);
const live = liveOrFail('invites', hasDbEnv());

describe.skipIf(!live)('createInvite — role ceiling and token handling', () => {
  let ws = '';
  let admin = '';

  beforeAll(async () => {
    const sql = adminSql();
    const w = await sql<{ id: string }[]>`insert into workspaces (name) values (${`Inv WS ${RUN}`}) returning id`;
    ws = w[0]!.id;
    const p = await sql<{ id: string }[]>`
      insert into principals (email, email_normalized)
      values (${`inv-admin-${RUN}@ex.com`}, ${normalizeEmail(`inv-admin-${RUN}@ex.com`)})
      returning id`;
    admin = p[0]!.id;
    await sql`insert into workspace_members (workspace_id, principal_id, role) values (${ws}, ${admin}, 'admin')`;
  }, 60_000);

  afterAll(async () => {
    const sql = adminSql();
    await sql`delete from invites where workspace_id = ${ws}`;
    await sql`delete from workspace_members where workspace_id = ${ws}`;
    await sql`delete from workspaces where id = ${ws}`;
    await sql`delete from principals where id = ${admin}`;
    await closePools({ timeout: 5 });
  }, 60_000);

  const ctxFor = (role: string) =>
    buildContext({ principal: admin, workspaceId: ws, role, grants: resolveGrants(admin, ws), remote: false });

  it('an ADMIN cannot mint an OWNER invite, and nothing is written', async () => {
    const ctx = ctxFor('admin');
    await expect(
      withScopedTx(ctx, (tx) => createInvite(tx, ctx, { email: `esc-${RUN}@ex.com`, role: 'owner' })),
    ).rejects.toMatchObject({ code: 'insufficient_role' });

    // The guard must not merely reject the response — the row must not exist. cb_app holds INSERT
    // on invites, so a guard that threw after the write would still have escalated.
    const rows = await adminSql()`select id from invites where workspace_id = ${ws} and role = 'owner'`;
    expect(rows.length).toBe(0);
  }, 60_000);

  it('an admin CAN invite at or below its own role', async () => {
    const ctx = ctxFor('admin');
    for (const role of ['admin', 'member']) {
      const inv = await withScopedTx(ctx, (tx) => createInvite(tx, ctx, { email: `ok-${role}-${RUN}@ex.com`, role }));
      expect(inv.inviteId).toBeTruthy();
    }
  }, 60_000);

  it('stores only the HASH, returns the raw token exactly once, and stamps the caller workspace', async () => {
    const ctx = ctxFor('owner');
    const inv = await withScopedTx(ctx, (tx) => createInvite(tx, ctx, { email: `hash-${RUN}@ex.com`, role: 'member' }));

    expect(inv.token.length).toBe(TOKEN_LENGTH);
    const row = (await adminSql()<{ token_hash: string; workspace_id: string; email_normalized: string }[]>`
      select token_hash, workspace_id, email_normalized from invites where id = ${inv.inviteId}`)[0]!;

    expect(row.token_hash).toBe(hashToken(inv.token));
    expect(row.token_hash).not.toBe(inv.token); // the raw token is never persisted
    expect(row.workspace_id).toBe(ws); // stamped from ctx, not from params
    expect(row.email_normalized).toBe(normalizeEmail(`hash-${RUN}@ex.com`));
  }, 60_000);

  it('rejects a role outside the enum before touching the database', async () => {
    const ctx = ctxFor('owner');
    await expect(
      withScopedTx(ctx, (tx) => createInvite(tx, ctx, { email: `bad-${RUN}@ex.com`, role: 'superuser' })),
    ).rejects.toMatchObject({ code: 'invalid_params' });
  }, 60_000);

  it('the accept URL carries the token in a FRAGMENT, never a query string', async () => {
    const ctx = ctxFor('owner');
    const inv = await withScopedTx(ctx, (tx) => createInvite(tx, ctx, { email: `url-${RUN}@ex.com`, role: 'member' }));
    const url = new URL(inv.acceptUrl);
    // A query string reaches the server and lands in access logs, history and Referer headers.
    expect(url.search).toBe('');
    expect(url.hash).toContain(encodeURIComponent(inv.token));
  }, 60_000);
});

describe.skipIf(!live)('create_invite is reachable as an operation', () => {
  it('is registered in the ops registry as an admin-only mutating op', async () => {
    const { operationsByName } = await import('../src/api/operations.ts');
    const op = operationsByName.create_invite;
    expect(op).toBeDefined();
    expect(op!.requiredRole).toBe('admin');
    expect(op!.mutating).toBe(true);
  });

  it('appears in the discovery catalog, so an agent can find it', async () => {
    const { operations } = await import('../src/api/operations.ts');
    const { buildToolDefs } = await import('../src/api/tool-defs.ts');
    const names = buildToolDefs(operations.filter((o) => !o.hidden)).map((t: { name: string }) => t.name);
    expect(names).toContain('create_invite');
  });

  afterAll(async () => closePools({ timeout: 5 }));
});
