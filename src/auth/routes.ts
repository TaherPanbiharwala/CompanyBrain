// The eight auth routes. Mounted BEFORE mountApi so they sit ahead of /api/:op and ahead of the
// terminal error middleware.
//
// One rule governs the whole file: every cookie route except POST /api/:op consumes
// `resolveSessionRow` and reads the raw `reason`, because they all exist to serve sessions that may
// legitimately have no workspace yet (that is the entire point of the bootstrap route). Only
// server.ts uses `resolveSessionContext`, which turns a workspace-less session into a 400.
import type { Express, Request, Response, NextFunction } from 'express';
import { config, isLoopbackHost } from '../config.ts';
import { appSql, authLane } from '../db/client.ts';
import { OperationError } from '../api/errors.ts';
import { devLoginEnabled } from '../api/dev-auth.ts';
import { startAuth, completeAuth, safeReturnTo, type VerifiedIdentity } from './google.ts';
import { onboard, createWorkspace, activateWorkspace } from './workspaces.ts';
import { acceptByToken } from './invites.ts';
import { resolveSessionRow, type SessionRow } from './resolver.ts';
import { normalizeEmail } from './normalize.ts';
import {
  issueSession, revokeSession, revokeAllSessions,
  sessionCookieName, sessionCookieAttrs, oauthCookieName, oauthCookieAttrs,
  signPayload, verifyPayload, clearAuthCookie, DEV_LOGIN_TTL_DAYS,
} from './session.ts';
import { authLimiter } from './ratelimit.ts';

interface OauthState {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
}

/** Structured, shape-only auth logging. The /auth/* routes sit outside mountApi, so they inherit
 *  none of the dispatch logger — without this, a failed login leaves no trace at all. Never logs a
 *  token, a code, or a cookie value. */
function logAuth(reqId: string, stage: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: 'info', kind: 'auth', ts: new Date().toISOString(), reqId, auth_stage: stage, ...fields }));
}

function reqIdOf(req: Request, res: Response): string {
  const existing = res.getHeader('x-request-id');
  if (typeof existing === 'string') return existing;
  // Client-supplied, so it is echoed into a response header AND into every log line for this
  // request. Cap it: unbounded attacker-controlled text in structured logs is a log-volume and
  // log-parsing problem even though Node rejects the control characters that would allow splitting.
  const supplied = req.header('x-request-id');
  const id = supplied && supplied.length <= 200 ? supplied : crypto.randomUUID();
  res.setHeader('x-request-id', id);
  return id;
}

function sendError(res: Response, reqId: string, err: OperationError): void {
  res.status(err.status).json({ ok: false, reqId, error: err.toWire() });
}

/** Wraps a handler so any throw becomes the standard envelope rather than a stack trace. */
function handler(stage: string, fn: (req: Request, res: Response, reqId: string) => Promise<void>) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const reqId = reqIdOf(req, res);
    try {
      await fn(req, res, reqId);
    } catch (err) {
      if (err instanceof OperationError) {
        logAuth(reqId, `${stage}:rejected`, { code: err.code });
        sendError(res, reqId, err);
        return;
      }
      // Detail server-side only; the caller gets a generic envelope via the terminal middleware.
      console.error(`[auth_error] reqId=${reqId} stage=${stage}`, err);
      next(err);
    }
  };
}

/** Session-cookie lane for the non-/api routes: 401 unless there is a live session, but a session
 *  with NO workspace is perfectly acceptable here. */
async function requireSession(req: Request, res: Response, reqId: string): Promise<SessionRow | null> {
  const row = await resolveSessionRow(req);
  if (!row || row.reason === 'expired' || row.reason === 'epoch_stale' || !row.principalId) {
    sendError(res, reqId, new OperationError('unauthenticated', 'no valid session', 'Sign in at /auth/google.'));
    return null;
  }
  return row;
}

export function mountAuth(app: Express): void {
  // Rate limit for the whole /auth surface. CSRF is NOT here: it is mounted app-wide in index.ts as
  // csrfGuard, so that /api/:op is covered too — scoping it to this router is exactly the bug the
  // M2 review found.
  app.use('/auth', (req: Request, res: Response, next: NextFunction) => {
    const reqId = reqIdOf(req, res);
    const key = req.ip ?? 'unknown';
    if (authLimiter.hit(key)) {
      res.setHeader('retry-after', String(authLimiter.retryAfterSeconds(key)));
      logAuth(reqId, 'rate_limited');
      sendError(res, reqId, new OperationError('rate_limited', 'too many requests', 'Wait a minute and try again.'));
      return;
    }
    next();
  });

  // 1. Start the OIDC dance.
  app.get('/auth/google', handler('start', async (req, res, reqId) => {
    const { redirectUrl, state, nonce, codeVerifier } = await startAuth();
    // Express 5's query parser yields an ARRAY for a repeated key, so the old
    // `req.query.return_to as string` cast was unsound. And an over-long value produces a signed
    // cookie past the browser's ~4KB per-cookie limit, which the browser silently DROPS — the
    // callback then reports "the sign-in session expired or was tampered with", a thoroughly
    // misleading error for an oversized redirect target. safeReturnTo already falls back to '/'.
    const rawReturnTo = Array.isArray(req.query.return_to) ? req.query.return_to[0] : req.query.return_to;
    const returnTo = safeReturnTo(typeof rawReturnTo === 'string' && rawReturnTo.length <= 512 ? rawReturnTo : undefined);
    const payload: OauthState = { state, nonce, codeVerifier, returnTo };
    res.cookie(oauthCookieName(), signPayload(payload), oauthCookieAttrs());
    logAuth(reqId, 'start');
    res.redirect(302, redirectUrl);
  }));

  // 2. Come back from Google.
  app.get('/auth/google/callback', handler('callback', async (req, res, reqId) => {
    const jar = (req as Request & { cookies?: Record<string, unknown> }).cookies;
    const signed = jar?.[oauthCookieName()];
    const stateData = typeof signed === 'string' ? verifyPayload<OauthState>(signed) : null;
    if (!stateData) {
      throw new OperationError(
        'unauthenticated',
        'the sign-in session expired or was tampered with',
        'Start again at /auth/google. (If this repeats on http://localhost, check that the cookie is not being dropped.)',
      );
    }
    clearAuthCookie(res, oauthCookieName(), oauthCookieAttrs());

    const currentUrl = new URL(req.originalUrl, config.APP_BASE_URL);
    let identity: VerifiedIdentity;
    try {
      identity = await completeAuth(currentUrl, stateData);
    } catch (err) {
      // Every library throw is an auth failure. The discriminated cause goes to the server log only.
      console.error(`[auth_error] reqId=${reqId} stage=callback:verify`, err);
      throw new OperationError('unauthenticated', 'google sign-in could not be verified', 'Try signing in again.');
    }
    logAuth(reqId, 'verified', { has_hd: Boolean(identity.hd) });

    const result = await onboard(identity);
    logAuth(reqId, 'onboarded', { workspace_less: result.activeWorkspaceId === null });

    const session = await issueSession(await authLane(), {
      principalId: result.principalId,
      activeWorkspaceId: result.activeWorkspaceId,
      loginHd: identity.hd ?? null,
    });
    res.cookie(sessionCookieName(), session.raw, sessionCookieAttrs());
    logAuth(reqId, 'session_issued');
    res.redirect(302, stateData.returnTo);
  }));

  // 3. Dev-login. Only mounted when ALL five gates pass — a route that merely 401s would still
  //    confirm it exists. The per-request hostname check is a belt on top of the mount-time gate.
  if (devLoginEnabled()) {
    app.post('/auth/dev-login', handler('dev_login', async (req, res, reqId) => {
      // Same predicate as the boot gate (config.isLoopbackHost) — NOT a second hand-rolled list.
      // The two used to disagree over '[::1]', which Express's req.hostname does produce.
      if (!isLoopbackHost(req.hostname || '')) {
        res.status(404).json({ ok: false, reqId, error: { code: 'not_found', message: 'not found' } });
        return;
      }
      const email = (req.body as { email?: unknown } | undefined)?.email;
      if (typeof email !== 'string' || !email.includes('@')) {
        throw new OperationError('invalid_params', 'body must be {"email":"you@example.com"}');
      }
      // Synthetic identity. The `dev:` prefix cannot collide with Google's numeric `sub`, and
      // hd:null structurally removes the domain auto-join branch AND any domain claim later.
      const identity: VerifiedIdentity = {
        sub: `dev:${normalizeEmail(email)}`,
        email: email.trim(),
        emailVerified: true,
      };
      const result = await onboard(identity);
      const session = await issueSession(await authLane(), {
        principalId: result.principalId,
        activeWorkspaceId: result.activeWorkspaceId,
        loginHd: null,
        ttlDays: DEV_LOGIN_TTL_DAYS,
      });
      // ONE constant drives both the row's expiry and the cookie's Max-Age.
      res.cookie(sessionCookieName(), session.raw, sessionCookieAttrs(DEV_LOGIN_TTL_DAYS));
      logAuth(reqId, 'dev_login', { workspace_less: result.activeWorkspaceId === null });
      res.json({
        ok: true,
        reqId,
        principal_id: result.principalId,
        workspace_id: result.activeWorkspaceId,
        role: result.role,
        next: result.activeWorkspaceId ? 'POST /api/whoami' : 'POST /auth/workspaces',
      });
    }));
  }

  // 4. Logout (this session).
  app.post('/auth/logout', handler('logout', async (req, res, reqId) => {
    const row = await requireSession(req, res, reqId);
    if (!row) return;
    await revokeSession(appSql(), row.rawToken);
    clearAuthCookie(res, sessionCookieName(), sessionCookieAttrs());
    logAuth(reqId, 'logout');
    res.json({ ok: true, reqId, data: { signed_out: true } });
  }));

  // 5. Logout everywhere. 401 (not 200) when there is no live session, so a no-op is never
  //    reported as a successful global sign-out.
  app.post('/auth/logout-all', handler('logout_all', async (req, res, reqId) => {
    const row = await requireSession(req, res, reqId);
    if (!row) return;
    await revokeAllSessions(appSql(), row.rawToken);
    clearAuthCookie(res, sessionCookieName(), sessionCookieAttrs());
    logAuth(reqId, 'logout_all');
    res.json({ ok: true, reqId, data: { signed_out_everywhere: true } });
  }));

  // 6. Bootstrap: the route that makes a fresh install usable at all.
  app.post('/auth/workspaces', handler('create_workspace', async (req, res, reqId) => {
    const row = await requireSession(req, res, reqId);
    if (!row) return;
    const body = (req.body ?? {}) as { name?: unknown; domain?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length < 1 || name.length > 80) {
      throw new OperationError('invalid_params', 'name must be 1..80 characters');
    }
    const domain = typeof body.domain === 'string' && body.domain ? body.domain : null;
    const created = await createWorkspace({
      principalId: row.principalId!,
      tokenHash: row.tokenHash,
      name,
      domain,
    });
    logAuth(reqId, 'workspace_created', { claimed_domain: domain !== null });
    res.json({ ok: true, reqId, workspace_id: created.workspaceId, principal_id: row.principalId, role: created.role });
  }));

  // 7. Switch the active workspace.
  app.post('/auth/workspaces/:id/activate', handler('activate_workspace', async (req, res, reqId) => {
    const row = await requireSession(req, res, reqId);
    if (!row) return;
    const workspaceId = String(req.params.id ?? '');
    try {
      const out = await activateWorkspace({ principalId: row.principalId!, tokenHash: row.tokenHash, workspaceId });
      logAuth(reqId, 'workspace_activated');
      res.json({ ok: true, reqId, workspace_id: out.workspaceId, role: out.role });
    } catch (err) {
      // A bad uuid, a non-existent workspace and a real non-membership all look identical from
      // outside — otherwise this becomes a workspace-existence oracle.
      if (err instanceof OperationError) throw err;
      // Narrow, not blanket. activateWorkspace already returns permission_denied for a genuine
      // non-membership, so the ONLY thing this arm needs to normalize is a malformed uuid, which
      // Postgres reports as 22P02. Catching everything meant a dropped connection, a statement
      // timeout or pool exhaustion was reported to the user as "not a member of that workspace" —
      // and swallowed, so there was no server-side trace either. During a database incident every
      // user would be told they had lost access to their own workspace.
      if ((err as { code?: string } | null)?.code === '22P02') {
        throw new OperationError('permission_denied', 'not a member of that workspace');
      }
      throw err; // real failure → handler() logs it and the terminal middleware returns a 500
    }
  }));

  // 8. Accept an invite. Token-only: this is the ONLY path that grants a cross-tenant membership.
  app.post('/auth/invites/accept', handler('invite_accept', async (req, res, reqId) => {
    const row = await requireSession(req, res, reqId);
    if (!row) return;
    // BODY ONLY. The `?? req.query.token` fallback is deliberately gone: accepting the token from a
    // query string legitimized putting it there, and a query string is recorded in proxy/CDN access
    // logs, browser history and the Referer header of anything the page loads afterwards. This is
    // the single credential that grants a cross-tenant membership.
    const token = (req.body as { token?: unknown } | undefined)?.token;
    if (typeof token !== 'string' || !token) {
      throw new OperationError('invalid_params', 'body must be {"token":"…"}');
    }
    const who = await (await authLane())<{ email_normalized: string }[]>`
      select email_normalized from principals where id = ${row.principalId}`;
    const emailNormalized = who[0]?.email_normalized;
    if (!emailNormalized) throw new OperationError('unauthenticated', 'principal not found');

    const accepted = await acceptByToken({
      rawToken: token,
      principalId: row.principalId!,
      principalEmailNormalized: emailNormalized,
      tokenHash: row.tokenHash,
    });
    logAuth(reqId, 'invite_accepted');
    res.json({ ok: true, reqId, workspace_id: accepted.workspaceId, role: accepted.role });
  }));
}
