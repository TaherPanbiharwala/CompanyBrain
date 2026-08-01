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
import { WEB_DIST, isViteDevActive, assertWebBuildPresent } from '../src/web.ts';

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
    // THE regression this file was written for. mountAuth is registered immediately before mountApi in index.ts, so a
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

    // A bare app.use(spaFallback()) would land before mountAuth and, absent the belt,
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
    // The FULL policy, not a sample. The previous version asserted 6 of the 11 directives, so
    // deleting connect-src, img-src, font-src, form-action or style-src left it green — and
    // connect-src is the one that turns a successful injection into exfiltration. A directive
    // that is absent is not restrictive-by-default: CSP falls back to default-src for the
    // fetch directives and to NOTHING AT ALL for base-uri, form-action and frame-ancestors.
    for (const directive of [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ]) {
      expect(csp, `CSP is missing: ${directive}`).toContain(directive);
    }
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    // The non-CSP half of the header set, which nothing asserted at all.
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
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

describe('the server-path prefix belt is case-insensitive', () => {
  // isServerPath() lowercases before comparing. Removing that leaves every other assertion in this
  // file green, because they all request lowercase paths.
  //
  // The case that matters is NOT /API/_ops: Express routes case-insensitively by default (index.ts
  // never sets `case sensitive routing`), so that reaches the real handler and spaFallback is never
  // consulted — an assertion there passes with or without the lowercase and proves nothing. The
  // difference appears only on an UNMATCHED path under a server prefix, which is precisely where
  // the fallback gets its turn. Verified red by deleting the .toLowerCase().
  it('an unmatched /API/* path gets the JSON 404, not index.html', async () => {
    const res = await fetch(`${base}/API/no_such_op`, { headers: { accept: 'text/html' } });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { ok: boolean; error?: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('not_found');
  });

  it('an unmatched /Auth/* path gets the JSON 404 too', async () => {
    // This one is the security-relevant half. A 200 text/html on /Auth/anything means the SPA is
    // answering inside the auth namespace — the shape of the mount-order bug the plan shipped with,
    // arriving through a different door.
    const res = await fetch(`${base}/Auth/nope`, { headers: { accept: 'text/html' } });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('/HEALTH is matched by Express itself — the premise this belt is built on', async () => {
    // Documents WHY the lowercase is needed: routing already ignores case, so any path-prefix check
    // that does not is checking something Express is not.
    const res = await fetch(`${base}/HEALTH`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('ok');
  });
});

describe('assertWebBuildPresent', () => {
  // The gate between "the UI build step did not run" and a server that boots green and 404s every
  // page. /health is pure memory and says ok either way, so nothing else catches that deploy.
  //
  // The first version of this suite did not test it. Parameterizing the CONFIG was not enough: the
  // throw still read the module-level INDEX_HTML, so the case opened with
  // `if (hasBuild) { ...not.toThrow(); return; }` and asserted the inverse of its own name whenever
  // a build existed. Adding `bun run build:web` to the offline CI job — in the same change — made
  // that true permanently on CI. Two edits that each looked right, cancelling each other.
  //
  // Measured before the fix: replacing this function's entire body with `return;` left this file at
  // 19 pass / 0 fail. The path is injectable now, so the negative is unconditional and no longer
  // depends on the state of the working tree.
  const ABSENT = '/nonexistent-dir-for-this-test/web/dist/index.html';

  it('THROWS off-loopback when the index is absent — unconditionally', () => {
    expect(() => assertWebBuildPresent({ appBaseIsLoopback: false }, ABSENT)).toThrow(/build/i);
  });

  it('returns quietly off-loopback when the index IS present — the other half', () => {
    // Without this, a gate that threw unconditionally would also pass the case above. Any file that
    // certainly exists works; package.json is the least likely to move.
    const present = new URL('../package.json', import.meta.url).pathname;
    expect(() => assertWebBuildPresent({ appBaseIsLoopback: false }, present)).not.toThrow();
  });

  it('returns quietly on loopback REGARDLESS of the path', () => {
    // The loopback early return is what lets `bun run dev` work before the first build. It must win
    // over the missing file, or local development boots into the deploy error.
    expect(() => assertWebBuildPresent({ appBaseIsLoopback: true }, ABSENT)).not.toThrow();
  });

  it('defaults to the REAL dist path — the injected arg is for tests, not a second source of truth', () => {
    // Guards the other direction: a default that drifted away from WEB_DIST would make all three
    // cases above pass while index.ts checked the wrong location. Only assertable when a build
    // exists, so it is stated as a conditional rather than silently skipped.
    if (!hasBuild) return;
    expect(() => assertWebBuildPresent({ appBaseIsLoopback: false })).not.toThrow();
    expect(existsSync(`${WEB_DIST}/index.html`)).toBe(true);
  });

  it('index.ts actually CALLS it — the gate is wired, not merely exported', async () => {
    // Deleting the call from index.ts breaks nothing above: the function keeps passing its own unit
    // tests while no longer guarding a boot. D97: break the subject and delete it.
    const src = await Bun.file(new URL('../src/index.ts', import.meta.url)).text();
    expect(src).toMatch(/^assertWebBuildPresent\(\);$/m);
  });
});
