// Committed form of the manual 3-case RLS check, plus the new integrity FKs (review sec S1/S9).
// Env-gated: skips cleanly without Supabase creds; runs live against the DB when they're present.
// This is a down payment on the M3 leak canary, not a replacement for it.
//
// Note: assert rejections with try/catch, NOT `expect(query).rejects` — a postgres.js tagged
// template is a lazy thenable and bun's rejects matcher hangs when handed one directly.
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { appSql, adminSql, withScopedTx } from '../src/db/client.ts';
import { buildContext, resolveGrants } from '../src/core/context.ts';

const live = !!process.env.DATABASE_URL && !!process.env.DATABASE_ADMIN_URL;

async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

describe.skipIf(!live)('RLS smoke — tenant isolation + integrity FKs', () => {
  let ws1 = '';
  let ws2 = '';
  let p1 = '';
  let p2 = '';
  let page1 = '';

  beforeAll(async () => {
    const admin = adminSql();
    p1 = (await admin<{ id: string }[]>`insert into principals (email, email_normalized) values (${'rls-a@ex.com'}, ${'rls-a@ex.com'}) returning id`)[0]!.id;
    p2 = (await admin<{ id: string }[]>`insert into principals (email, email_normalized) values (${'rls-b@ex.com'}, ${'rls-b@ex.com'}) returning id`)[0]!.id;
    ws1 = (await admin<{ id: string }[]>`insert into workspaces (name, created_by) values (${'rls-ws1'}, ${p1}) returning id`)[0]!.id;
    ws2 = (await admin<{ id: string }[]>`insert into workspaces (name, created_by) values (${'rls-ws2'}, ${p2}) returning id`)[0]!.id;
    await admin`insert into workspace_members (workspace_id, principal_id, role) values (${ws1}, ${p1}, 'owner'), (${ws2}, ${p2}, 'owner')`;
    page1 = (await admin<{ id: string }[]>`insert into pages (workspace_id, slug, owner_principal, scope, acl) values (${ws1}, ${'p1'}, ${p1}, 'workspace', ${['ws:' + ws1]}) returning id`)[0]!.id;
    await admin`insert into pages (workspace_id, slug, owner_principal, scope, acl) values (${ws2}, ${'p2'}, ${p2}, 'workspace', ${['ws:' + ws2]})`;
  });

  afterAll(async () => {
    const admin = adminSql();
    await admin`delete from workspaces where id in (${ws1}, ${ws2})`; // cascades pages/members/chunks
    await admin`delete from principals where id in (${p1}, ${p2})`; // cascades sessions
    // Bound the close — a graceful .end() over Supabase's pooler can otherwise hang and stall bun.
    await appSql().end({ timeout: 5 });
    await admin.end({ timeout: 5 });
  });

  it('no GUC set -> cb_app sees 0 rows (fail closed)', async () => {
    const sql = appSql();
    const rows = await sql`select id from pages`;
    expect(rows.length).toBe(0);
  });

  it('scoped to ws1 -> sees exactly its own page', async () => {
    const ctx = buildContext({ principal: p1, workspaceId: ws1, grants: resolveGrants(p1, ws1), remote: false });
    const rows = await withScopedTx(ctx, (tx) => tx<{ workspace_id: string }[]>`select id, workspace_id from pages`);
    expect(rows.length).toBe(1);
    expect(rows[0]!.workspace_id).toBe(ws1);
  });

  it('scoped to ws2 -> sees 0 of ws1 pages (cross-tenant blocked)', async () => {
    const ctx = buildContext({ principal: p2, workspaceId: ws2, grants: resolveGrants(p2, ws2), remote: false });
    const rows = await withScopedTx(ctx, (tx) => tx`select id from pages where workspace_id = ${ws1}`);
    expect(rows.length).toBe(0);
  });

  it('composite FK blocks a chunk stamped with the wrong tenant', async () => {
    const admin = adminSql();
    // page1 belongs to ws1; stamping the chunk workspace_id=ws2 must violate the (page_id, workspace_id) FK.
    const blocked = await rejects(
      () => admin`insert into content_chunks (workspace_id, page_id, acl, ord, content) values (${ws2}, ${page1}, ${['ws:' + ws2]}, 0, ${'x'})`,
    );
    expect(blocked).toBe(true);
  });

  it('membership FK blocks a session whose active workspace is not a membership', async () => {
    const admin = adminSql();
    // p2 is a member of ws2, not ws1 -> sessions(active_workspace_id, principal_id) -> workspace_members violated.
    const blocked = await rejects(
      () => admin`insert into sessions (principal_id, active_workspace_id, token_hash, expires_at) values (${p2}, ${ws1}, ${'h-' + crypto.randomUUID()}, now() + interval '1 day')`,
    );
    expect(blocked).toBe(true);
  });
});
