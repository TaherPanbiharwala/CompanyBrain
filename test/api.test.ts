// Live HTTP integration for the M1 spine (review §6). Env-gated: needs Supabase creds AND dev-auth
// on (DEV_AUTH=1, non-prod), since /api/:op resolves identity via the dev-auth stub. Run with:
//   DEV_AUTH=1 bun test test/api.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { app } from '../src/index.ts';
import { adminSql, closePools } from '../src/db/client.ts';
import { config } from '../src/config.ts';
import { apiLimiter } from '../src/auth/ratelimit.ts';
import { liveOrFail, hasDbEnv } from './helpers/live.ts';

// Per-run unique addresses: email_normalized is UNIQUE, and cleanup only runs in afterAll,
// so a crashed run would otherwise poison every future run's setup.
const RUN = crypto.randomUUID().slice(0, 8);

const canRun = liveOrFail(
  'api',
  hasDbEnv() && config.DEV_AUTH === 1 && config.NODE_ENV !== 'production',
);

describe.skipIf(!canRun)('api /api/:op (live, dev-auth)', () => {
  let server: Server;
  let base = '';
  let p1 = '';
  let p2 = '';
  let ws1 = '';
  let ws2 = '';

  const hdr = (principal: string, workspace: string, role: string) => ({
    'content-type': 'application/json',
    'x-cb-principal': principal,
    'x-cb-workspace': workspace,
    'x-cb-role': role,
  });
  const post = (path: string, headers: Record<string, string>, body: unknown = {}) =>
    fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const readJson = (res: Response): Promise<any> => res.json();

  beforeAll(async () => {
    apiLimiter.reset();
    const admin = adminSql();
    p1 = (await admin<{ id: string }[]>`insert into principals (email, email_normalized) values (${`api-a-${RUN}@ex.com`}, ${`api-a-${RUN}@ex.com`}) returning id`)[0]!.id;
    p2 = (await admin<{ id: string }[]>`insert into principals (email, email_normalized) values (${`api-b-${RUN}@ex.com`}, ${`api-b-${RUN}@ex.com`}) returning id`)[0]!.id;
    ws1 = (await admin<{ id: string }[]>`insert into workspaces (name, created_by) values (${'api-ws1'}, ${p1}) returning id`)[0]!.id;
    ws2 = (await admin<{ id: string }[]>`insert into workspaces (name, created_by) values (${'api-ws2'}, ${p2}) returning id`)[0]!.id;
    await admin`insert into workspace_members (workspace_id, principal_id, role) values (${ws1}, ${p1}, 'admin'), (${ws2}, ${p2}, 'owner')`;
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server?.close();
    const admin = adminSql();
    await admin`delete from workspaces where id in (${ws1}, ${ws2})`;
    await admin`delete from principals where id in (${p1}, ${p2})`;
    await closePools({ timeout: 5 });
  });

  it('whoami returns the header identity', async () => {
    const res = await post('/api/whoami', hdr(p1, ws1, 'admin'));
    expect(res.status).toBe(200);
    const j = await readJson(res);
    expect(j.data.workspaceId).toBe(ws1);
    expect(j.data.role).toBe('admin');
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('get_workspace returns the caller\'s own workspace (RLS)', async () => {
    const r1 = await readJson(await post('/api/get_workspace', hdr(p1, ws1, 'admin')));
    expect(r1.data.name).toBe('api-ws1');
    const r2 = await readJson(await post('/api/get_workspace', hdr(p2, ws2, 'owner')));
    expect(r2.data.name).toBe('api-ws2'); // ws2 caller sees ws2, never ws1 — RLS
  });

  it('list_members is admin-gated (member 403, admin 200)', async () => {
    expect((await post('/api/list_members', hdr(p1, ws1, 'member'))).status).toBe(403);
    const ok = await post('/api/list_members', hdr(p1, ws1, 'admin'));
    expect(ok.status).toBe(200);
    const j = await readJson(ok);
    expect(Array.isArray(j.data)).toBe(true);
    expect(j.data.map((m: { principal_id: string }) => m.principal_id)).toContain(p1);
  });

  it('no identity headers → 401', async () => {
    const res = await post('/api/whoami', { 'content-type': 'application/json' });
    expect(res.status).toBe(401);
    expect((await readJson(res)).error.code).toBe('unauthenticated');
  });

  it('GET /api/_ops lists the visible tools (not echo)', async () => {
    const j = await readJson(await fetch(`${base}/api/_ops`));
    const names = j.data.map((t: { name: string }) => t.name);
    expect(names).toContain('whoami');
    expect(names).not.toContain('echo');
  });
});
