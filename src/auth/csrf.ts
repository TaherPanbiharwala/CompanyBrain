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
import { sessionCookieName } from './session.ts';

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
 * The middleware that makes the rule above actually property-scoped.
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
  if (checkCsrf(req).ok) {
    // Covers the safe-method exemption too — checkCsrf short-circuits on GET/HEAD/OPTIONS.
    next();
    return;
  }

  const cookies = (req as Request & { cookies?: Record<string, unknown> }).cookies;
  const carriesSession = typeof cookies?.[sessionCookieName()] === 'string';
  const isAuthSurface = req.path.startsWith('/auth/');
  if (!carriesSession && !isAuthSurface) {
    next();
    return;
  }

  const verdict = checkCsrf(req);
  const reqId = (typeof res.getHeader('x-request-id') === 'string' ? (res.getHeader('x-request-id') as string) : null)
    ?? req.header('x-request-id')
    ?? crypto.randomUUID();
  res.setHeader('x-request-id', reqId);
  console.log(JSON.stringify({
    level: 'info', kind: 'auth', ts: new Date().toISOString(), reqId,
    auth_stage: 'csrf_rejected', path: req.path, reason: verdict.reason,
  }));
  const err = new OperationError('permission_denied', 'cross-site request rejected',
    'This request was blocked because it originated from another site.');
  res.status(err.status).json({ ok: false, reqId, error: err.toWire() });
}
