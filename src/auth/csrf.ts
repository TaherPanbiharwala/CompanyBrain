// CSRF for cookie-authenticated requests.
//
// Once /api/:op authenticates from a cookie, a cross-site page can make the browser send that
// cookie on a POST. SameSite=Lax blocks the common cases, but it is a browser-side control with
// known gaps, so the server checks the request's own origin signals too.
//
// The rule is scoped by request PROPERTY, not by path: it applies to any non-GET request that
// authenticated via cookie. If BOTH signals are absent the request is allowed — browsers always
// send at least one of them on a cross-origin POST, so "neither present" means a non-browser client
// (curl, the runbook, a server-side integration), which cannot be CSRF'd in the first place.
//
// `checkCsrf` is the predicate; `csrfGuard` below is what enforces it, and it is mounted ONCE for
// the whole app. Keep it that way: for most of M2 this file said "scoped by request PROPERTY" while
// the only caller was `app.use('/auth', …)`, leaving POST /api/:op — the surface named two
// paragraphs up — entirely unchecked.
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.ts';
import { OperationError } from '../api/errors.ts';
import { sendError, shedIfLimited } from '../api/envelope.ts';
import { sessionCookieName } from './session.ts';
import { preAuthLimiter } from './ratelimit.ts';
import { requestId } from '../api/reqid.ts';
import { logAuth } from './log.ts';
import { isViteDevActive } from '../web.ts';

function appOrigin(): string {
  try {
    return new URL(config.APP_BASE_URL).origin;
  } catch {
    return '';
  }
}

export interface CsrfVerdict {
  ok: boolean;
  reason?: string;
}

/** GET/HEAD/OPTIONS are exempt (they must not mutate). Everything else is checked. */
export function checkCsrf(req: Request): CsrfVerdict {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return { ok: true };

  // Sec-Fetch-Site is the strongest signal and is sent by every current browser.
  const site = req.header('sec-fetch-site');
  if (site) {
    // 'none' = typed in the address bar / bookmark; 'same-origin' = our own page.
    if (site === 'same-origin' || site === 'none') return { ok: true };
    return { ok: false, reason: `cross-site request (Sec-Fetch-Site: ${site})` };
  }

  // Older browsers: fall back to Origin.
  const origin = req.header('origin');
  if (origin) {
    const expected = appOrigin();
    if (expected && origin === expected) return { ok: true };
    return { ok: false, reason: 'Origin does not match APP_BASE_URL' };
  }

  // Neither header: not a browser. Nothing to forge a request from.
  return { ok: true };
}

/**
 * Coarse IP-keyed flood shed, mounted app-wide BEFORE anything resolves identity.
 *
 * Ordering is the entire point. `apiLimiter` is keyed on the principal, so it cannot run until
 * `resolveSessionContext` has already spent a database round trip on the `cb_app` pool — meaning the
 * limiter protecting that pool could never protect it from UNAUTHENTICATED traffic. And the
 * resolver's shape check rejects malformed cookies from memory but accepts any random 43-char
 * base64url string, so a junk-cookie flood reached the database unimpeded. At Seoul latency with a
 * 10-connection pool that is roughly 80 req/s to full saturation.
 *
 * This is a shed, not a budget: generous enough that no real client notices, cheap enough that it
 * costs a map lookup. `apiLimiter` still runs afterwards as the real per-principal budget.
 */
/** Paths only an in-process Vite dev server answers. `/node_modules/.vite/` covers the prebundled
 *  dependency chunks; `/@id/` and `/@fs/` cover Vite's virtual and filesystem module ids. */
const VITE_DEV_PREFIXES = ['/@vite/', '/@react-refresh', '/@id/', '/@fs/', '/node_modules/.vite/'] as const;

export function preAuthGuard(req: Request, res: Response, next: NextFunction): void {
  // ONLY /health is exempt. It is a pure in-memory response (src/index.ts) that a platform health
  // checker polls continuously from one address and must never be shed.
  //
  // /health/db is NOT exempt, and the exemption that used to cover it was the bug this guard exists
  // to prevent: it calls appSql() and checks out a connection from the SAME 10-slot cb_app pool
  // described above, so exempting it left one unauthenticated, DB-touching, unthrottled route —
  // a cheaper version of the junk-cookie flood, needing no cookie at all. The comment that justified
  // it ("neither touches the tenant pool") was simply false. A health checker polling once every few
  // seconds is nowhere near 300/min, so it is unaffected by being shed-eligible.
  if (req.path === '/health') {
    next();
    return;
  }
  // Vite's own dev-server paths, and ONLY while an in-process Vite is actually running.
  //
  // In middleware mode Vite serves every source module as its own request — ~13 files in web/src plus
  // /@vite/client, /@react-refresh, the Tailwind module and several prebundled dep chunks, roughly 20
  // per full reload. Against 300/min/IP that is ~15 reloads a minute before the shed fires, and when
  // it fires the developer gets a JSON 429 where an ES module should be: a white screen for 60
  // seconds, with nothing naming the cause. HMR avoids most full reloads, so it bites exactly during
  // the config and Tailwind edits that force one.
  //
  // Cannot widen the production surface: isViteDevActive() is set only by createViteDev, which is
  // gated on import.meta.main AND isDevEnv, so in any deployed process this is permanently false and
  // these prefixes are shed like everything else. They are also not paths the production build ever
  // serves — a built bundle has no /@vite/ or /@id/.
  if (isViteDevActive() && VITE_DEV_PREFIXES.some((p) => req.path.startsWith(p))) {
    next();
    return;
  }
  const key = req.ip ?? 'unknown';
  const reqId = requestId(req, res);
  if (shedIfLimited(preAuthLimiter, key, res, reqId, 'Slow down and retry shortly.')) {
    logAuth(reqId, 'pre_auth_rate_limited', { path: req.path });
    return;
  }
  next();
}

/**
 * The middleware that makes the CSRF rule above actually property-scoped.
 *
 * It was path-scoped until the M2 review: `checkCsrf` had exactly one caller, `app.use('/auth', …)`,
 * so `POST /api/:op` — the cookie-authenticated surface carrying every mutating operation, and the
 * case this module's header cites by name — was never checked. The test that should have caught it
 * asserted `expect(res.status).toBeGreaterThan(0)`, which no HTTP response can fail.
 *
 * Mount ONCE in index.ts, ahead of both routers, so a router added later inherits it rather than
 * having to remember it.
 *
 * Applies to a non-safe request when EITHER:
 *   - it carries a session cookie (the stated property — it authenticated via cookie), or
 *   - it targets /auth/* (session-minting and membership-granting; worth covering even before a
 *     session exists, so login-CSRF cannot start a session the victim did not ask for).
 * An unauthenticated POST to anything else has no ambient authority to abuse, so it passes through
 * and is rejected on its own merits.
 */
export function csrfGuard(req: Request, res: Response, next: NextFunction): void {
  // Evaluated ONCE and reused: this used to call checkCsrf twice and discard the first verdict, so
  // the `reason` that reached the log came from a second, independent evaluation of the request.
  const verdict = checkCsrf(req);
  if (verdict.ok) {
    // Covers the safe-method exemption too — checkCsrf short-circuits on GET/HEAD/OPTIONS.
    next();
    return;
  }

  const cookies = (req as Request & { cookies?: Record<string, unknown> }).cookies;
  const carriesSession = typeof cookies?.[sessionCookieName()] === 'string';
  // toLowerCase because EXPRESS ROUTES CASE-INSENSITIVELY by default (`case sensitive routing` is
  // off and index.ts never enables it), so `/AUTH/dev-login` reaches the same handler while
  // `startsWith('/auth/')` returned false — skipping the login-CSRF arm on a request the router
  // treats as an auth route. Narrow in practice (this arm only covers auth routes carrying no
  // session cookie) but it is a bypass of a check meant to be unconditional.
  const isAuthSurface = req.path.toLowerCase().startsWith('/auth/');
  if (!carriesSession && !isAuthSurface) {
    next();
    return;
  }

  const reqId = requestId(req, res);
  logAuth(reqId, 'csrf_rejected', { path: req.path, reason: verdict.reason });
  sendError(res, reqId, new OperationError('permission_denied', 'cross-site request rejected',
    'This request was blocked because it originated from another site.'));
}
