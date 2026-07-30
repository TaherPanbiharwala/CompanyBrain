// Mount ORDER for the web UI. This is the guard for the highest-risk line in M5 Phase 0.
//
// Deliberately OFFLINE: it boots the shared Express app and speaks HTTP to it, touching no database
// and importing no db client. That keeps it out of test/live-gate.test.ts's live-suite detector
// entirely (touchesDb() looks for a src/db/client.ts import, hasDbEnv(), or process.env.DATABASE_*),
// so it needs no liveOrFail gate and no REQUIRED_LIVE_SUITES entry. Cheapest possible coverage for
// the thing most likely to break.
//
// What it exists to catch: the SPA fallback has exactly one legal position — after every /auth and
// /api route, before the API's catch-all 404. Both ends of that window live inside mountApi(), so
// the ordering cannot be expressed by a caller and cannot be eyeballed from index.ts. Every failure
// mode below is silent in the sense that the app still boots and /health still says ok.
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { app } from '../src/index.ts';
import { WEB_DIST, isViteDevActive } from '../src/web.ts';

let server: Server;
let base: string;

beforeAll(() => {
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
});

const hasBuild = existsSync(`${WEB_DIST}/index.html`);

describe('web mount order', () => {
  it('GET /api/_ops still returns the op catalog, not the SPA', async () => {
    // A fallback registered before mountApi (or before mountAuth) shadows this. It is also E1's
    // only input, so a UI that generated its forms from it would be generating them from HTML.
    const res = await fetch(`${base}/api/_ops`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { ok: boolean; data: unknown[] };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
  });

  it('an unmatched /api path returns the JSON 404 envelope, never HTML', async () => {
    // GET (not POST) on an op path: app.post('/api/:op') does not match, so this reaches the
    // fallback. Without the /api/ prefix guard in spaFallback it would receive index.html with a
    // 200, and any client that JSON.parse()s the body gets a syntax error instead of the closed
    // envelope the API promises everywhere else.
    const res = await fetch(`${base}/api/whoami`);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('not_found');
  });

  it('GET /auth/google reaches the auth router and is never answered by the SPA', async () => {
    // THE regression this file was written for. mountAuth is index.ts:76 and mountApi is :77, so a
    // fallback placed "before mountApi" is also before mountAuth and swallows the entire sign-in
    // flow — returning index.html with a 200 for the first step of the M5 gate.
    //
    // Asserted as a NEGATIVE rather than "302 to accounts.google.com", because this suite runs
    // offline with no GOOGLE_CLIENT_ID: the route then throws from google.ts and lands on the API's
    // terminal error middleware. Both outcomes prove the property under test — the auth router,
    // not the SPA, handled this path. Pinning the 302 would have made the test depend on
    // credentials it has no business needing.
    const res = await fetch(`${base}/auth/google`, { redirect: 'manual' });
    expect(res.headers.get('content-type') ?? '').not.toContain('text/html');
    expect(await res.text()).not.toContain('<div id="root">');
  });

  it('the service index moved to /api and still answers', async () => {
    const res = await fetch(`${base}/api`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service: string };
    expect(body.service).toBe('company-brain');
  });

  it('a missing asset 404s rather than being answered with index.html', async () => {
    // The deploy-race case: a cached index.html references chunk names a new build no longer emits.
    // Answering those with HTML gives the browser a MIME/parse error instead of a 404, which is
    // dramatically harder to diagnose from either end.
    const res = await fetch(`${base}/assets/does-not-exist-a1b2c3.js`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type') ?? '').not.toContain('text/html');
  });

  it('a non-HTML client gets the JSON 404, not a page it cannot parse', async () => {
    const res = await fetch(`${base}/some/spa/route`, { headers: { accept: 'application/json' } });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it.skipIf(!hasBuild)('an unknown non-API route serves the SPA when a build exists', async () => {
    const res = await fetch(`${base}/some/spa/route`, { headers: { accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/html');
    expect(await res.text()).toContain('<div id="root">');
  });

  it.skipIf(!hasBuild)('/invites/accept is served by the SPA — the route invites.ts links to', async () => {
    // src/auth/invites.ts:90 builds acceptUrl as `${APP_BASE_URL}/invites/accept#token=…`. That URL
    // has been shipping since M2. If the SPA does not own this path, every invite link 404s.
    const res = await fetch(`${base}/invites/accept`, { headers: { accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/html');
  });
});

describe('the fallback reaches the app ONLY through mountApi', () => {
  // Why this is a source scan and not a behavioural test, stated plainly because the reasoning is
  // the interesting part:
  //
  // I sabotaged index.ts to mount spaFallback() before mountAuth — the exact bug the plan for this
  // phase originally specified — and every behavioural test above still PASSED. Not because they
  // are weak, but because spaFallback carries its own isServerPath() belt, so it correctly declines
  // /auth/* and /api/* from any position. Deleting the belt instead turns the JSON-404 test red
  // (verified), so the belt IS pinned. The POSITION is not, and cannot be, by behaviour alone:
  // with the belt intact both positions behave identically for every path.
  //
  // The position still matters as defence in depth — it is what saves sign-in if SERVER_PREFIXES
  // ever drifts behind a newly added route family. So it gets a structural guard instead, in the
  // same idiom test/dispatch-limit.test.ts uses to pin that apiLimiter left server.ts.
  it('index.ts never mounts spaFallback directly', async () => {
    const src = await Bun.file(new URL('../src/index.ts', import.meta.url)).text();
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l))
      .join('\n');

    // A bare app.use(spaFallback()) would land before mountAuth (index.ts:76) and, absent the belt,
    // swallow GET /auth/google — returning index.html with a 200 for step 1 of the M5 gate.
    expect(code).not.toMatch(/app\.use\(\s*spaFallback\(\)/);
    // It must arrive as mountApi's option, which registers it after every route and before the 404.
    expect(code).toMatch(/mountApi\([\s\S]{0,200}webFallback/);
  });

  it('mountApi registers the fallback before its catch-all, not after', async () => {
    const src = await Bun.file(new URL('../src/api/server.ts', import.meta.url)).text();
    const fallbackAt = src.indexOf('opts.webFallback');
    const notFoundAt = src.indexOf("'not_found'");
    expect(fallbackAt).toBeGreaterThan(0);
    expect(notFoundAt).toBeGreaterThan(0);
    // Registered after the 404 means the 404 already answered and the fallback is dead code.
    expect(fallbackAt).toBeLessThan(notFoundAt);
  });
});

describe('security headers', () => {
  // These are not decoration. Auth is a cookie, there is deliberately no CSRF token, and the op set
  // includes create_invite — so script executing on this origin has full authority over every
  // mutating operation. Ingested document text and model output are both rendered by the SPA, and
  // the injection suite exists because untrusted page content actively tries to steer the model.
  it('sets a CSP that blocks inline and third-party script', async () => {
    const res = await fetch(`${base}/health`);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('the dev-only script-src relaxation cannot leak into a non-Vite process', async () => {
    // @vitejs/plugin-react injects an inline module script in dev, which strict script-src blocks —
    // so dev genuinely needs 'unsafe-inline'. The risk is that relaxation escaping into production.
    // It is gated on a flag that only createViteDev() sets, NOT on NODE_ENV: 'test' is a dev env by
    // config.ts's allowlist and CI sets it explicitly, so an env-based gate would relax the policy
    // inside this very assertion. This suite never starts Vite, so the strict policy must hold here
    // regardless of what NODE_ENV says.
    expect(isViteDevActive()).toBe(false);
    const res = await fetch(`${base}/health`);
    expect(res.headers.get('content-security-policy') ?? '').toContain("script-src 'self';");
  });

  it('sets nosniff and DENY framing on API responses too, not just HTML', async () => {
    // App-wide rather than on the HTML route: nosniff is what stops a browser treating the flood
    // shed's JSON envelope as script when it fires on an /assets/*.js request.
    const res = await fetch(`${base}/api/_ops`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});
