// Live HTTP integration for the M1 spine (review §6). Env-gated: needs Supabase creds AND dev-auth
// on (DEV_AUTH=1, non-prod), since /api/:op resolves identity via the dev-auth stub. Run with:
//   DEV_AUTH=1 bun test test/api.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { app } from '../src/index.ts';
import { adminSql, closePools } from '../src/db/client.ts';
import { config } from '../src/config.ts';
import { apiLimiter, preAuthLimiter } from '../src/auth/ratelimit.ts';
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
    preAuthLimiter.reset();
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

  it('list_members is admin-gated (member 403, admin 200) and NEVER leaks another tenant', async () => {
    expect((await post('/api/list_members', hdr(p1, ws1, 'member'))).status).toBe(403);
    const ok = await post('/api/list_members', hdr(p1, ws1, 'admin'));
    expect(ok.status).toBe(200);
    const j = await readJson(ok);
    const ids = j.data.map((m: { principal_id: string }) => m.principal_id);
    expect(ids).toContain(p1);

    // THE assertion this test was missing. `Array.isArray` plus "contains p1" both hold perfectly
    // well while the response ALSO carries ws2's members — the failure that matters here is not an
    // absent row, it is an extra one. workspace_members is the tenancy plane itself, so a leak here
    // is a leak of who else exists as a customer.
    expect(ids).not.toContain(p2);
    const wsIds = j.data.map((m: { workspace_id?: string }) => m.workspace_id).filter(Boolean);
    for (const w of wsIds) expect(w).toBe(ws1);

    // …and symmetrically from the other side, so the test cannot pass by ws2 simply being empty.
    const other = await readJson(await post('/api/list_members', hdr(p2, ws2, 'owner')));
    const otherIds = other.data.map((m: { principal_id: string }) => m.principal_id);
    expect(otherIds).toContain(p2);
    expect(otherIds).not.toContain(p1);
  });

  it('no identity headers → 401', async () => {
    const res = await post('/api/whoami', { 'content-type': 'application/json' });
    expect(res.status).toBe(401);
    expect((await readJson(res)).error.code).toBe('unauthenticated');
  });

  it('GET /api/_ops lists the visible tools (not echo), unauthenticated, in the standard envelope', async () => {
    // No cookie and no dev-auth headers: unauthenticated discovery is the DECIDED behaviour (D53),
    // not an oversight, so it is asserted rather than left to drift.
    const res = await fetch(`${base}/api/_ops`);
    expect(res.status).toBe(200);
    const j = await readJson(res);
    expect(j.ok).toBe(true);
    // It used to be the one route with no reqId, so a client could not special-case-free parse it.
    expect(typeof j.reqId).toBe('string');
    expect(j.reqId.length).toBeGreaterThan(0);
    const names = j.data.map((t: { name: string }) => t.name);
    expect(names).toContain('whoami');
    expect(names).not.toContain('echo');
  });

  // ── The two limiters, at the route ──────────────────────────────────────
  // Both were unverifiable before the M1+M2 review: apiLimiter is reset by every suite that touches
  // /api and was never driven past its ceiling, so deleting the block from server.ts broke nothing —
  // structurally the same hole already documented and closed for authLimiter.
  it('apiLimiter blocks at 429 and is keyed on the PRINCIPAL, not globally', async () => {
    apiLimiter.reset();
    preAuthLimiter.reset();
    try {
      let last: Response | undefined;
      for (let i = 0; i < 121; i++) last = await post('/api/whoami', hdr(p1, ws1, 'admin'));
      expect(last!.status).toBe(429);
      const body = await readJson(last!);
      expect(body.error.code).toBe('rate_limited');
      expect(Number(last!.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(body.reqId).toBeTruthy(); // the envelope holds even on the throttled path

      // The load-bearing half: a DIFFERENT principal is unaffected. A global counter would 429 here.
      expect((await post('/api/whoami', hdr(p2, ws2, 'owner'))).status).toBe(200);
    } finally {
      apiLimiter.reset();
      preAuthLimiter.reset();
    }
  }, 180_000);

  it('preAuthLimiter sheds a junk-cookie flood BEFORE any database round trip', async () => {
    // The ordering bug it exists for: apiLimiter is keyed on the principal, so it cannot fire until
    // resolveSessionContext has already spent a round trip on the cb_app pool. A well-formed but
    // fake 43-char cookie passes looksLikeToken, so the flood reached the database unimpeded.
    apiLimiter.reset();
    preAuthLimiter.reset();
    try {
      const junk = () =>
        fetch(`${base}/api/whoami`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: `cb_session=${'A'.repeat(43)}` },
          body: '{}',
        });
      const timed = async (): Promise<{ status: number; ms: number }> => {
        const t = performance.now();
        const r = await junk();
        return { status: r.status, ms: performance.now() - t };
      };

      // BASELINE, measured before the limiter trips: a junk cookie passes looksLikeToken, so this
      // request reaches cb_internal.resolve_session and pays a real round trip to the database.
      // Capturing the cost here is what lets the assertion below be about ORDERING rather than about
      // some absolute millisecond number that depends on where the database happens to live.
      const baseline = await timed();
      expect(baseline.status).toBe(401); // rejected, but only AFTER the round trip

      // CONCURRENTLY, in batches. Sequentially these take ~250ms each precisely because they reach
      // the database — which is the problem this guard exists for — so 301 of them span longer than
      // the 60s window and it resets underneath the test. That is a property of the flood, not of
      // the limiter: a real flood arrives in parallel, so the test should too.
      const statuses: number[] = [];
      for (let batch = 0; batch < 7; batch++) {
        const results = await Promise.all(Array.from({ length: 50 }, junk));
        statuses.push(...results.map((r) => r.status));
        if (statuses.includes(429)) break;
      }
      expect(statuses).toContain(429);

      // …and everything before the shed was a plain 401, not a 5xx — the guard rejects cleanly.
      expect(statuses.filter((s) => s >= 500)).toEqual([]);
      const shed = await junk();
      expect(shed.status).toBe(429);
      expect((await readJson(shed)).error.code).toBe('rate_limited');
      expect(Number(shed.headers.get('retry-after'))).toBeGreaterThan(0);

      // THE ORDERING ASSERTION — the property this test is named for, and the only thing that
      // distinguishes preAuthLimiter from apiLimiter. A shed request must not pay the round trip the
      // baseline above paid: preAuthGuard runs ahead of resolveSessionContext, so the decision is a
      // map lookup. If the guard were mounted after the resolver (the bug it exists for), a shed
      // request would cost the same as the baseline and this would fail.
      //
      // A ratio, not a constant: the absolute numbers depend on the link, but "shed costs a fraction
      // of a database round trip" holds wherever the database is. Median of several to shrug off one
      // slow scheduling hiccup.
      const shedTimes: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t = await timed();
        expect(t.status).toBe(429);
        shedTimes.push(t.ms);
      }
      shedTimes.sort((a, b) => a - b);
      const shedMedian = shedTimes[2]!;
      expect(shedMedian).toBeLessThan(baseline.ms / 4);

      // /health must never be shed — a platform health checker polls it from one address forever.
      expect((await fetch(`${base}/health`)).status).toBe(200);
    } finally {
      apiLimiter.reset();
      preAuthLimiter.reset();
    }
  }, 180_000);
});
