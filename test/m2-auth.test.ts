// M2 end-to-end, against the real database and the real Express app.
//
// This is the milestone's canary. Every case here maps to a specific defect found during review, so
// a regression fails loudly rather than quietly re-opening a cross-tenant hole. It drives the HTTP
// surface (not the modules directly) because the routes are where the lanes and the cookie handling
// actually live.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { app } from '../src/index.ts';
import { adminSql, appSql, closePools } from '../src/db/client.ts';
import { hashToken } from '../src/auth/session.ts';
import { normalizeEmail } from '../src/auth/normalize.ts';
import { config } from '../src/config.ts';
import { authLimiter, apiLimiter } from '../src/auth/ratelimit.ts';
import { onboard } from '../src/auth/workspaces.ts';
import { assertMembership, membershipRole } from '../src/auth/membership.ts';
import { liveOrFail, hasDbEnv } from './helpers/live.ts';

const RUN = crypto.randomUUID().slice(0, 8);
// Needs the auth pool AND the dev-login flags on top of the usual connection strings — this suite
// drives the real HTTP surface, and dev-login is how it mints sessions without a Google project.
const live = liveOrFail(
  'm2-auth',
  hasDbEnv() && !!process.env.DATABASE_AUTH_URL && config.DEV_AUTH === 1 && config.DEV_LOGIN === 1,
);

/** Minimal cookie jar — enough to carry one session cookie across requests like a browser would. */
class Jar {
  private jar = new Map<string, string>();
  capture(res: Response): void {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq);
      const value = pair!.slice(eq + 1);
      if (value === '' ) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }
  header(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  get size(): number { return this.jar.size; }
}

/** Run a statement and return its Postgres SQLSTATE if it was refused, or undefined if it SUCCEEDED.
 *  Returning the code (rather than a boolean) is what lets a test assert WHY it was refused — a
 *  privilege denial (42501) and an incidental connection failure are not the same result. */
async function deniedCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code ?? 'unknown';
  }
}

describe.skipIf(!live)('M2 auth — end to end', () => {
  let server: Server;
  let base = '';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = (res: Response): Promise<any> => res.json();

  const post = (path: string, jar?: Jar, body: unknown = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(jar ? { cookie: jar.header() } : {}) },
      body: JSON.stringify(body),
      redirect: 'manual',
    });

  /** dev-login → returns a jar holding a real session cookie. */
  async function devLogin(email: string): Promise<{ jar: Jar; body: any }> {
    const jar = new Jar();
    const res = await post('/auth/dev-login', undefined, { email });
    jar.capture(res);
    return { jar, body: await json(res) };
  }

  // The /auth limiter is per-process in-memory state keyed on IP, and every test here shares
  // 127.0.0.1 — without this the later tests 403 on the limiter rather than exercising their case.
  beforeEach(() => { authLimiter.reset(); apiLimiter.reset(); });

  beforeAll(async () => {
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    server?.close();
    const admin = adminSql();
    // Match on the RUN-tagged EMAIL, not on the google_sub prefix. The account-conflict test seeds a
    // principal with a `google:` sub, which the old `dev:%` pattern missed — so every run leaked one
    // row permanently into the shared database.
    const like = `%-${RUN}@ex.com`;
    await admin`delete from workspaces where created_by in (select id from principals where email_normalized like ${like})`;
    await admin`delete from principals where email_normalized like ${like}`;
    await admin`delete from principals where email_normalized like ${`adopt%${RUN}%`}`;
    await closePools({ timeout: 5 });
  }, 60_000);

  // ── The DX P0 claim: a fresh install is usable with no Google project ────
  describe('local dev sequence (dev-login → bootstrap → whoami)', () => {
    it('dev-login mints a real session but lands WORKSPACE-LESS on a fresh principal', async () => {
      const { jar, body } = await devLogin(`seq-${RUN}@ex.com`);
      expect(body.ok).toBe(true);
      expect(body.principal_id).toBeTruthy();
      // The whole reason the bootstrap route had to exist: onboarding has nothing to join.
      expect(body.workspace_id).toBeNull();
      expect(body.next).toBe('POST /auth/workspaces');
      expect(jar.size).toBeGreaterThan(0);
    }, 60_000);

    it('a workspace-less session gets 400 no_workspace from /api/:op — not a 401', async () => {
      const { jar } = await devLogin(`seq2-${RUN}@ex.com`);
      const res = await post('/api/whoami', jar);
      expect(res.status).toBe(400);
      const j = await json(res);
      expect(j.error.code).toBe('no_workspace');
      // It must point at the fix, and must NOT fall through to the dev-auth header stub.
      expect(j.error.suggestion).toMatch(/POST \/auth\/workspaces/);
    }, 60_000);

    it('bootstrap then whoami completes the loop', async () => {
      const { jar } = await devLogin(`seq3-${RUN}@ex.com`);
      const created = await post('/auth/workspaces', jar, { name: `Seq WS ${RUN}` });
      expect(created.status).toBe(200);
      const cj = await json(created);
      expect(cj.role).toBe('owner');

      const who = await post('/api/whoami', jar);
      expect(who.status).toBe(200);
      const wj = await json(who);
      expect(wj.data.workspaceId).toBe(cj.workspace_id);
      expect(wj.data.role).toBe('owner');
      expect(wj.data.remote).toBe(false); // first-party session, not the MCP/agent lane
      expect(wj.data.grants).toEqual([`self:${cj.principal_id}`, `ws:${cj.workspace_id}`]);
    }, 60_000);
  });

  // ── CRITICAL-1: `hd` transport, and the domain-squat it prevents ─────────
  describe('domain claim requires a verified hd for THIS login', () => {
    it('rejects a domain claim when the session has no verified hd (the dev-login case)', async () => {
      const { jar } = await devLogin(`dom-${RUN}@ex.com`);
      const res = await post('/auth/workspaces', jar, { name: 'Squat', domain: 'bigco.com' });
      expect(res.status).toBe(400);
      expect((await json(res)).error.code).toBe('domain_not_verified');
    }, 60_000);

    it('accepts a domain that matches the session login_hd', async () => {
      const { jar, body } = await devLogin(`hd-${RUN}@ex.com`);
      // login_hd is stamped by the callback at INSERT time and is NOT updatable by cb_auth (its
      // only sessions UPDATE grant is active_workspace_id), so simulate it as the owner.
      const domain = `hd-${RUN}.example`;
      await adminSql()`
        update sessions set login_hd = ${domain}
        where principal_id = ${body.principal_id} and active_workspace_id is null`;
      const res = await post('/auth/workspaces', jar, { name: 'Real Co', domain });
      expect(res.status).toBe(200);
      const rows = await adminSql()<{ domain: string }[]>`
        select domain from workspaces where id = ${(await json(res)).workspace_id}`;
      expect(rows[0]!.domain).toBe(domain);
    }, 60_000);

    it('rejects a domain that does NOT match the verified hd', async () => {
      const { jar, body } = await devLogin(`hd2-${RUN}@ex.com`);
      await adminSql()`
        update sessions set login_hd = ${`mine-${RUN}.example`}
        where principal_id = ${body.principal_id} and active_workspace_id is null`;
      const res = await post('/auth/workspaces', jar, { name: 'Not Mine', domain: `theirs-${RUN}.example` });
      expect(res.status).toBe(400);
      expect((await json(res)).error.code).toBe('domain_not_verified');
    }, 60_000);

    it('removal from a domain workspace is DURABLE — a block survives the next login', async () => {
      // Drives onboard() directly rather than /auth/dev-login, because dev-login sets hd:null by
      // design — that is precisely what "structurally removes the domain auto-join branch" means, so
      // the branch under test is unreachable through it. A real Google Workspace login is the only
      // other way in, and this asserts the same code path without needing one.
      //
      // The bug: memberships are rows that exist or do not, with no "was removed" state, so removing
      // someone from a domain-claimed workspace silently undid itself on their very next sign-in.
      const domain = `dur-${RUN}.example`;
      const admin = adminSql();

      const w = await admin<{ id: string }[]>`
        insert into workspaces (name, domain) values (${`Dur ${RUN}`}, ${domain}) returning id`;
      const ws = w[0]!.id;

      const identity = { sub: `google:dur-${RUN}`, email: `dur-emp-${RUN}@ex.com`, emailVerified: true as const, hd: domain };

      // First sign-in on that domain: auto-joined as a member. (This half also proves auto-join works.)
      const joined = await onboard(identity);
      expect(joined.activeWorkspaceId).toBe(ws);
      expect(joined.role).toBe('member');

      // They leave. Removal is an admin action in M2 — cb_app holds no DELETE on workspace_members.
      await admin`delete from workspace_members where workspace_id = ${ws} and principal_id = ${joined.principalId}`;

      // Without a tombstone the very next sign-in would put them straight back.
      await admin`
        insert into workspace_domain_blocks (workspace_id, principal_id, reason)
        values (${ws}, ${joined.principalId}, 'left the company')`;

      const after = await onboard(identity);
      expect(after.principalId).toBe(joined.principalId); // same human, same principal
      expect(after.activeWorkspaceId).toBeNull(); // workspace-less, NOT silently re-admitted
      const members = await admin`
        select 1 from workspace_members where workspace_id = ${ws} and principal_id = ${joined.principalId}`;
      expect(members.length).toBe(0);

      await admin`delete from workspace_domain_blocks where workspace_id = ${ws}`;
      await admin`delete from workspaces where id = ${ws}`;
      await admin`delete from principals where id = ${joined.principalId}`;
    }, 90_000);
  });

  // ── E1: the grant matrix, exercised as cb_app actually experiences it ────
  describe('cb_app cannot destroy or escalate (E1/E2 grant matrix)', () => {
    it('cannot DELETE its own workspace, membership row, or another tenant', async () => {
      const { jar, body } = await devLogin(`del-${RUN}@ex.com`);
      const created = await json(await post('/auth/workspaces', jar, { name: `Del WS ${RUN}` }));
      const sql = appSql();

      // Even fully scoped to its own tenant, the app role holds no DELETE. WITH CHECK(false) does
      // not block DELETE — the grant revoke is what does.
      for (const stmt of [
        sql`delete from workspaces where id = ${created.workspace_id}`,
        sql`delete from workspace_members where workspace_id = ${created.workspace_id}`,
      ]) {
        // Assert the SQLSTATE, not merely that SOMETHING threw. A bare `catch { denied = true }`
        // passes for a typo'd table name, a closed pool, or a statement timeout — so the test
        // standing in for the tenancy boundary could go green for entirely the wrong reason.
        // 42501 is insufficient_privilege: the grant revoke is what stopped it.
        expect(await deniedCode(() => stmt)).toBe('42501');
      }
      // And the workspace is still there.
      const still = await adminSql()`select id from workspaces where id = ${created.workspace_id}`;
      expect(still.length).toBe(1);
      expect(body.principal_id).toBeTruthy();
    }, 60_000);

    it('cannot UPDATE workspaces.domain (the squat mutation path)', async () => {
      const { jar } = await devLogin(`upd-${RUN}@ex.com`);
      const created = await json(await post('/auth/workspaces', jar, { name: `Upd WS ${RUN}` }));
      expect(
        await deniedCode(() => appSql()`update workspaces set domain = ${'stolen.example'} where id = ${created.workspace_id}`),
      ).toBe('42501');
    }, 60_000);
  });

  // ── G2: sign-out-everywhere via session_epoch ───────────────────────────
  describe('session lifecycle', () => {
    it('logout-all invalidates OTHER live sessions too (epoch bump)', async () => {
      const email = `epoch-${RUN}@ex.com`;
      const a = await devLogin(email);
      await post('/auth/workspaces', a.jar, { name: `Epoch WS ${RUN}` });
      const b = await devLogin(email); // second device, same principal

      expect((await post('/api/whoami', b.jar)).status).toBe(200);
      expect((await post('/auth/logout-all', a.jar)).status).toBe(200);

      // Session B was never touched directly; the epoch bump is what kills it.
      const after = await post('/api/whoami', b.jar);
      expect(after.status).toBe(401);
    }, 60_000);

    it('logout-all on a session-less request is 401, never a silent 200', async () => {
      expect((await post('/auth/logout-all')).status).toBe(401);
    }, 60_000);

    it('revoking the membership mid-session drops the session to no_workspace', async () => {
      const { jar, body } = await devLogin(`revoke-${RUN}@ex.com`);
      const created = await json(await post('/auth/workspaces', jar, { name: `Revoke WS ${RUN}` }));
      expect((await post('/api/whoami', jar)).status).toBe(200);

      await adminSql()`
        delete from workspace_members where workspace_id = ${created.workspace_id} and principal_id = ${body.principal_id}`;
      // The composite FK nulls active_workspace_id in the same transaction, so the next resolve
      // sees no_active_ws — access is gone immediately, without touching the session row.
      const after = await post('/api/whoami', jar);
      expect(after.status).toBe(400);
      expect((await json(after)).error.code).toBe('no_workspace');
    }, 60_000);
  });

  // ── The 23505 adopt path (keeps a pre-seeded corpus reachable) ───────────
  describe('account adoption', () => {
    it('adopts a google_sub-less placeholder instead of forking the human into two principals', async () => {
      const email = `adopt-${RUN}@ex.com`;
      const normalized = normalizeEmail(email);
      const seeded = await adminSql()<{ id: string }[]>`
        insert into principals (email, email_normalized) values (${email}, ${normalized}) returning id`;
      const seededId = seeded[0]!.id;

      const { body } = await devLogin(email);
      // Same row, now bound to the dev identity — not a second principal.
      expect(body.principal_id).toBe(seededId);
      const all = await adminSql()`select id from principals where email_normalized = ${normalized}`;
      expect(all.length).toBe(1);
      const sub = await adminSql()<{ google_sub: string }[]>`select google_sub from principals where id = ${seededId}`;
      expect(sub[0]!.google_sub).toBe(`dev:${normalized}`);
    }, 60_000);

    it('a DIFFERENT identity for an already-claimed address is 409, never a 500', async () => {
      const email = `adopt2-${RUN}@ex.com`;
      const normalized = normalizeEmail(email);
      await adminSql()`
        insert into principals (google_sub, email, email_normalized)
        values (${`google:someone-else-${RUN}`}, ${email}, ${normalized})`;
      const res = await post('/auth/dev-login', undefined, { email });
      expect(res.status).toBe(409);
      expect((await json(res)).error.code).toBe('account_conflict');
    }, 60_000);
  });

  // ── Invites: the only cross-tenant membership path ──────────────────────
  describe('invites', () => {
    it('an expired invite fails the same generic way a forged token does', async () => {
      const { jar, body } = await devLogin(`inv-a-${RUN}@ex.com`);
      const ws = await json(await post('/auth/workspaces', jar, { name: `Inv WS ${RUN}` }));

      const guestEmail = `inv-b-${RUN}@ex.com`;
      const token = 'expired-token-' + RUN;
      await adminSql()`
        insert into invites (workspace_id, email, email_normalized, token_hash, role, invited_by, expires_at)
        values (${ws.workspace_id}, ${guestEmail}, ${normalizeEmail(guestEmail)}, ${hashToken(token)},
                'member', ${body.principal_id}, now() - interval '1 day')`;

      const guest = await devLogin(guestEmail);
      const res = await post('/auth/invites/accept', guest.jar, { token });
      expect(res.status).toBe(404);
      expect((await json(res)).error.code).toBe('invite_invalid');
    }, 60_000);

    it('an invite addressed to someone else is indistinguishable from a bad token', async () => {
      const { jar, body } = await devLogin(`inv-c-${RUN}@ex.com`);
      const ws = await json(await post('/auth/workspaces', jar, { name: `Inv2 WS ${RUN}` }));
      const token = 'mismatch-token-' + RUN;
      await adminSql()`
        insert into invites (workspace_id, email, email_normalized, token_hash, role, invited_by, expires_at)
        values (${ws.workspace_id}, ${'intended@ex.com'}, ${'intended@ex.com'}, ${hashToken(token)},
                'member', ${body.principal_id}, now() + interval '7 days')`;

      const wrong = await devLogin(`inv-d-${RUN}@ex.com`);
      const res = await post('/auth/invites/accept', wrong.jar, { token });
      expect(res.status).toBe(404);
      expect((await json(res)).error.code).toBe('invite_invalid');
    }, 60_000);

    it('a valid invite joins the guest, and a concurrent double-accept has exactly one winner', async () => {
      const { jar, body } = await devLogin(`inv-e-${RUN}@ex.com`);
      const ws = await json(await post('/auth/workspaces', jar, { name: `Inv3 WS ${RUN}` }));
      const guestEmail = `inv-f-${RUN}@ex.com`;
      const token = 'good-token-' + RUN;
      await adminSql()`
        insert into invites (workspace_id, email, email_normalized, token_hash, role, invited_by, expires_at)
        values (${ws.workspace_id}, ${guestEmail}, ${normalizeEmail(guestEmail)}, ${hashToken(token)},
                'member', ${body.principal_id}, now() + interval '7 days')`;

      const guest = await devLogin(guestEmail);
      const [r1, r2] = await Promise.all([
        post('/auth/invites/accept', guest.jar, { token }),
        post('/auth/invites/accept', guest.jar, { token }),
      ]);
      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual([200, 404]); // claim-first: exactly one winner

      const who = await post('/api/whoami', guest.jar);
      expect(who.status).toBe(200);
      const wj = await json(who);
      expect(wj.data.workspaceId).toBe(ws.workspace_id);
      expect(wj.data.role).toBe('member');
    }, 60_000);
  });

  // ── CSRF ────────────────────────────────────────────────────────────────
  it('a cross-site POST with a valid session cookie is rejected on BOTH surfaces', async () => {
    const { jar } = await devLogin(`csrf-${RUN}@ex.com`);
    await post('/auth/workspaces', jar, { name: `CSRF WS ${RUN}` });

    const crossSite = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: jar.header(), 'sec-fetch-site': 'cross-site' },
        body: JSON.stringify(body),
      });

    // The auth surface: session-minting and membership-granting.
    const authRes = await crossSite('/auth/workspaces', { name: 'evil' });
    expect(authRes.status).toBe(403);

    // The DATA surface. This assertion used to be `expect(res.status).toBeGreaterThan(0)` — which no
    // HTTP response can fail — under a test titled "is rejected", while /api/* sat outside the CSRF
    // middleware entirely. That is the exact shape CSRF exists to stop.
    const apiRes = await crossSite('/api/ingest', { slug: 'x', title: 'x', body: 'x' });
    expect(apiRes.status).toBe(403);
    expect((await json(apiRes)).error.code).toBe('permission_denied');

    // …and the same request from our own origin still works, so the guard is not just a blanket deny.
    const sameOrigin = await fetch(`${base}/api/whoami`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: jar.header(), 'sec-fetch-site': 'same-origin' },
      body: '{}',
    });
    expect(sameOrigin.status).toBe(200);
  }, 60_000);

  // ── Guards that had no test at all before the review ────────────────────
  describe('session expiry, membership, and the limiter', () => {
    it('an EXPIRED session is 401 and must NOT fall through to the dev-auth header stub', async () => {
      const { jar, body } = await devLogin(`exp-${RUN}@ex.com`);
      await post('/auth/workspaces', jar, { name: `Exp WS ${RUN}` });
      expect((await post('/api/whoami', jar)).status).toBe(200);

      await adminSql()`update sessions set expires_at = now() - interval '1 hour' where principal_id = ${body.principal_id}`;

      const res = await post('/api/whoami', jar);
      expect(res.status).toBe(401);

      // The subtle part: resolveSessionContext returns NULL for 'expired', and server.ts then falls
      // through to `?? resolveDevContext(req)`. With DEV_AUTH=1 (as here) a dead cookie plus forged
      // headers must still not authenticate — otherwise expiry is decorative in every dev env.
      const forged = await fetch(`${base}/api/whoami`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: jar.header(),
          'x-cb-principal': body.principal_id,
          'x-cb-workspace': crypto.randomUUID(),
          'x-cb-role': 'owner',
        },
        body: '{}',
      });
      expect(forged.status).not.toBe(200);
    }, 60_000);

    it('assertMembership returns the DATABASE role and refuses a fabricated pair (D25 off the HTTP path)', async () => {
      const { jar, body } = await devLogin(`mem-${RUN}@ex.com`);
      const ws = (await json(await post('/auth/workspaces', jar, { name: `Mem WS ${RUN}` }))).workspace_id;

      // The env can say which principal and workspace; it does NOT get to say the role.
      await adminSql()`update workspace_members set role = 'member' where workspace_id = ${ws} and principal_id = ${body.principal_id}`;
      expect(await membershipRole(body.principal_id, ws)).toBe('member');
      expect(await assertMembership(body.principal_id, ws)).toBe('member');

      // A pair that is not a real membership row must fail closed, not default to anything.
      const outsider = await devLogin(`mem-x-${RUN}@ex.com`);
      expect(await membershipRole(outsider.body.principal_id, ws)).toBeNull();
      await expect(assertMembership(outsider.body.principal_id, ws)).rejects.toThrow(/Not a member/i);
    }, 60_000);

    it('the /auth limiter actually blocks at the route, with 429 and a retry-after', async () => {
      // Every other test in this file calls authLimiter.reset() in beforeEach, which structurally
      // guarantees the limiter can never trip — so a regression that dropped the app.use('/auth')
      // mount entirely would have been invisible.
      authLimiter.reset();
      let last: Response | undefined;
      for (let i = 0; i < 31; i++) {
        last = await post('/auth/dev-login', undefined, { email: `rl-${i}-${RUN}@ex.com` });
      }
      expect(last!.status).toBe(429);
      expect((await json(last!)).error.code).toBe('rate_limited');
      expect(Number(last!.headers.get('retry-after'))).toBeGreaterThan(0);

      // …and it gates the whole surface, not just the route that tripped it.
      expect((await post('/auth/logout-all')).status).toBe(429);
      authLimiter.reset();
    }, 120_000);
  });
});
