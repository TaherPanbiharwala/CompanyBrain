// REST transport for the dispatch spine. Extracts the transport slice from gbrain's serve-http.ts
// /mcp handler (auth → dispatch) under MIT — see NOTICE — adapted to REST + company-brain ctx.
// M1 auth was the dev-auth stub. M2 did NOT replace it — it DEMOTED it to a local-only fallback
// reachable only when no session cookie was presented at all (D45). See the `hasSessionCookie(req)
// ? undefined : resolveDevContext(req)` line in the /api/:op handler — that expression is the demotion.
import express from 'express';
import type { Express, Request, Response, NextFunction, RequestHandler } from 'express';
import { ContextError } from '../core/context.ts';
import { operations } from './operations.ts';
import { buildToolDefs } from './tool-defs.ts';
import { dispatchOp } from './dispatch.ts';
import { mapContextError, OperationError } from './errors.ts';
import { sendError } from './envelope.ts';
import { requestId } from './reqid.ts';
import { resolveDevContext } from './dev-auth.ts';
import { resolveSessionContext, hasSessionCookie, resolveSessionRow } from '../auth/resolver.ts';

/** The one route whose body is a file. Exported so index.ts's app-wide parser can skip exactly this
 *  path and nothing else. index.ts now asks bodyLimitFor() instead, so this constant is consumed
 *  only inside this module and by test/body-limits.test.ts. */
export const UPLOAD_PATH = '/api/ingest_file';

/** This is the transport bound; the
 *  real limit is enforced on the DECODED bytes in importFile, which is the number that matters. */
// Sized from MAX_FILE_BYTES (25 MB), not chosen: base64 inflates 4/3, so 25 MB of file is 33.3 MB
// on the wire, plus the slug/title/tags/scope fields around it. 36mb is that number with headroom.
// test/body-limits.test.ts asserts the relationship rather than the value, so raising the file cap
// without raising this fails the suite instead of failing a user's upload with a bare 413.
export const UPLOAD_BODY_LIMIT = '36mb';

/** The batch counterpart to UPLOAD_PATH/UPLOAD_BODY_LIMIT above — same reasoning, wider body. */
export const BATCH_UPLOAD_PATH = '/api/ingest_files';

/** Sized from MAX_BATCH_FILES x UPLOAD_BODY_LIMIT's byte value, rounded up — the worst case is that
 *  many files each at UPLOAD_BODY_LIMIT's own worst case, buffered in one body. Not a guess:
 *  test/body-limits.test.ts asserts the relationship the same way it does for UPLOAD_BODY_LIMIT, so
 *  raising MAX_BATCH_FILES without raising this fails the suite instead of failing a batch upload
 *  with a bare 413. */
export const INGEST_FILES_BODY_LIMIT = '360mb';

/** The routes that carry a pasted document body (`ingest`, `replace_page`).
 *
 *  These exist because the ops advertise `body: z.string().max(MAX_BODY_CHARS)` — 200,000 characters
 *  — while the app-wide parser caps every request at 100kb. 200,000 characters of UTF-8 is 200KB to
 *  800KB, so the schema published in `/api/_ops` and in MCP `tools/list` promised something the
 *  transport could never accept, by a factor of 2x to 8x. Pasting an ordinary business document
 *  failed with `payload_too_large` naming "the 100kb limit" while the form said 200,000.
 *
 *  Latent while the only clients were curl and agents sending small bodies. The UI makes it routine:
 *  "paste a document" is the simplest form of the upload step, and a form generated from the
 *  published JSON-Schema would render maxLength=200000, validate against it client-side, and then
 *  413. */
export const PASTE_PATHS = ['/api/ingest', '/api/replace_page'] as const;

/** Sized FROM the schema rather than picked: worst-case UTF-8 is 4 bytes per character.
 *
 *  The "plus JSON string escaping" this comment used to claim does not fit and was never checked.
 *  200,000 * 4 = 800,000, leaving 248,576 bytes of the 1,048,576 — but JSON escaping is not bounded
 *  by 1.3x. zod's `.max()` counts UTF-16 code units, and a C0 control character is ONE unit that
 *  JSON.stringify emits as `\u0001`, six bytes. So a schema-VALID body of 200,000 control characters
 *  serialises to 1.2 MB and 413s.
 *
 *  Left at 1mb deliberately rather than raised to 2mb (6 bytes/unit): ordinary prose is at most ~3
 *  UTF-8 bytes per BMP unit, so a real document maxes out around 600KB, and doubling the buffer every
 *  paste route will accept — for a body made entirely of control characters, which no document is —
 *  trades a routine cost against a pathological one. The bound is stated here instead of implied, and
 *  test/body-limits.test.ts asserts the 4-byte case it actually covers. */
export const PASTE_BODY_LIMIT = '1mb';

/** The app-wide 100kb cap, named so the error message and index.ts's skip logic read the same
 *  constant rather than two string literals. */
export const STANDARD_BODY_LIMIT = '100kb';

/**
 * Which body limit applies to a path — the ONE answer, used by index.ts to decide whether to skip
 * the app-wide parser and by the error middleware to name the limit in a 413.
 *
 * Those were two independent expressions before, and they had already drifted once: the 413 message
 * hardcoded "100kb", which became a lie for the upload route the day that route got its own parser.
 * An error naming the wrong number sends someone shrinking a file that was never too big.
 *
 * Normalised the way Express's own router normalises, because BOTH of its default relaxations bite:
 *
 *   case  — it routes case-insensitively and index.ts never sets `case sensitive routing`, so
 *           `POST /api/Ingest_File` reaches the upload handler.
 *   slash — it routes non-strictly and index.ts never sets `strict routing` either, so
 *           `POST /api/ingest/` reaches the SAME mount.
 *
 * The first version handled only case, and three reviewers measured the consequence independently:
 * `POST /api/ingest/` with a 150KB body returned 413 naming the 100kb limit while `POST /api/ingest`
 * accepted it, and `POST /api/ingest_file/` with no cookie returned 413 rather than 401 — meaning the
 * app-wide parser threw before requireValidSession ever ran. Both fail CLOSED, so this is not a
 * bypass; it is the exact defect this function exists to prevent, reachable through a second
 * spelling: a 413 naming the wrong number, sending someone to shrink a file that was never too big.
 */
export function bodyLimitFor(path: string): string {
  const p = path.toLowerCase().replace(/\/+$/, '') || '/';
  if (p === UPLOAD_PATH) return UPLOAD_BODY_LIMIT;
  if (p === BATCH_UPLOAD_PATH) return INGEST_FILES_BODY_LIMIT;
  if ((PASTE_PATHS as readonly string[]).includes(p)) return PASTE_BODY_LIMIT;
  return STANDARD_BODY_LIMIT;
}

/** True when the route parses its own body inside mountApi, so index.ts's app-wide parser must not
 *  run first. */
export function parsesOwnBody(path: string): boolean {
  return bodyLimitFor(path) !== STANDARD_BODY_LIMIT;
}

export interface MountApiOptions {
  /**
   * Registered AFTER every /api route and BEFORE the catch-all 404 below. That window is the ONLY
   * legal place for a web-UI fallback, and it did not exist until M5 Phase 0 — both ends of it are
   * inside this function, so a caller had nowhere to put one.
   *
   * Do NOT mount a fallback in index.ts instead. `mountAuth` is registered immediately BEFORE
   * `mountApi` there, so anything registered "before mountApi" is also before mountAuth and a GET
   * catch-all there swallows /auth/google and /auth/google/callback — returning index.html with a
   * 200 and breaking sign-in, which is step 1 of the M5 gate. Registered after mountApi is equally
   * wrong: the 404 below has already answered. Passing it here is what keeps the invariant in the
   * module that owns both ends.
   */
  webFallback?: RequestHandler;
}


/**
 * Refuse to buffer a large body for a caller without a REAL session.
 *
 * VALIDITY, not presence — and that distinction is the whole guard.
 *
 * The first version tested `hasSessionCookie`, which is `readSessionCookie(req) !== null`: the cookie
 * being THERE, with no shape or database check. One header defeated it. Measured on this branch
 * before the fix: `Cookie: cb_session=junkjunkjunk` with a 9 MB body returned 413 "exceeds the 8mb
 * limit" — the raised parser had already engaged for a caller who authenticated nothing. The comment
 * below it claimed the opposite, and the test that was supposed to cover it sent NO cookie, which is
 * the one attacker who cannot do this.
 *
 * Note what the exposure actually is, because it changes the fix: express.json checks Content-Length
 * and rejects OVER-limit bodies without reading them, so the damage is not the 9 MB case — it is a
 * body sized just UNDER the cap, buffered and JSON.parse'd in full. No presence check can bound that,
 * because presence is free to forge. So this resolves the session for real.
 *
 * resolveSessionRow is the right call and already does both steps in the right order: it shape-checks
 * with looksLikeToken from memory (so garbage never costs a query) and only then does one indexed
 * lookup. An attacker with a well-formed forged token now pays a single primary-key read instead of
 * ~8 MB of heap. That read is NOT the flood control — preAuthGuard at 300/min/IP still is, and
 * resolver.ts:52-57 says so explicitly — but it changes the per-request cost by ~1000x, which is the
 * difference between a nuisance and a single-process server falling over.
 *
 * This double-resolves for a legitimate upload (resolveSessionContext looks the row up again during
 * dispatch). That is deliberate: these are three human-driven routes, not a hot path, and threading a
 * cached row through the dispatch spine to save one indexed read would couple this guard to it.
 */
async function requireValidSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  // resolveDevContext FIRST: it is pure header parsing with no I/O, and skipping it here is what
  // silently closed the M1/M2 dev-auth transport (D29/D45) on three of thirteen ops. The demotion
  // expression in the /api/:op handler below only consults the x-cb-* stub when NO session cookie is
  // present, so a header-authenticated caller reaching a cookie-only gate 401s — and did, with the
  // same forged identity getting 400 from /api/whoami and 401 from /api/ingest. That is the REST
  // transport behaving differently op-by-op for one identity, which nothing tested and no doc named.
  //
  // This cannot loosen production: devAuthEnabled() is double-gated on NODE_ENV and DEV_AUTH, and
  // assertDevAuthSafe() is a hard boot gate above it.
  if (resolveDevContext(req) !== null || (await resolveSessionRow(req)) !== null) {
    next();
    return;
  }
  sendError(res, requestId(req, res), new OperationError('unauthenticated', 'no authenticated identity',
    'Sign in at /auth/google before uploading. Large request bodies are only accepted for a signed-in session.'));
}

export function mountApi(app: Express, opts: MountApiOptions = {}): void {
  // Discovery: the same catalog MCP tools/list exposes, over REST (review AM8). Hidden ops excluded.
  //
  // DELIBERATELY UNAUTHENTICATED (D53). It publishes operation NAMES and JSON-Schemas — the API's own
  // documentation — and never touches a workspace, a principal or the tenant pool. The README's
  // quickstart curls it before you have a session, and an agent needs it to discover what to call, so
  // gating it would break both for no confidentiality gain: anyone who can read the repo has the same
  // list. `hidden` ops are excluded, which is where anything genuinely non-public belongs.
  //
  // It is NOT unprotected: preAuthGuard (300/min/IP, mounted app-wide in index.ts) sheds a flood
  // before this handler runs. It now also carries `reqId`, so it is the same closed envelope as every
  // other route rather than the one endpoint whose response shape a client has to special-case.
  app.get('/api/_ops', (req: Request, res: Response) => {
    const reqId = requestId(req, res);
    res.json({ ok: true, reqId, data: buildToolDefs(operations.filter((o) => !o.hidden)) });
  });

  // requireValidSession BEFORE the parser, on every route with a raised limit.
  //
  // The comment that used to sit here claimed an 8 MB body "has had to survive the flood shed and
  // present a valid CSRF token before anything parses it". The CSRF half was FALSE: csrfGuard
  // deliberately waves through any non-safe request that carries no session cookie and is not
  // targeting /auth/, because an unauthenticated caller has no ambient authority to abuse. So the
  // only thing in front of these parsers was preAuthGuard at 300 req/min/IP — verified live, a 6 MB
  // cross-site POST with no cookie was fully buffered and JSON.parse'd before returning 401.
  //
  // At 8 MB that is ~2.4 GB/min of pre-auth heap per IP against a single-process server, and M5a
  // widened it by adding two more raised-limit routes. This is the check csrfGuard cannot supply.
  //
  // It resolves the session for real rather than checking that a cookie exists — see the guard. The
  // first version checked presence, which one forged header defeated, so the paragraph above
  // described a protection the code did not have. That is the same failure mode as the CSRF comment
  // it replaced, one layer up, and it is why this now costs an indexed read.
  app.post(UPLOAD_PATH, requireValidSession, express.json({ limit: UPLOAD_BODY_LIMIT }));
  app.post(BATCH_UPLOAD_PATH, requireValidSession, express.json({ limit: INGEST_FILES_BODY_LIMIT }));
  for (const p of PASTE_PATHS) {
    app.post(p, requireValidSession, express.json({ limit: PASTE_BODY_LIMIT }));
  }

  app.post('/api/:op', async (req: Request, res: Response) => {
    const reqId = requestId(req, res);

    let ctx;
    try {
      // The `await` is load-bearing: a Promise is never nullish, so without it `ctx` would be a
      // pending Promise, sail past the `if (!ctx)` check below, and blow up inside dispatch —
      // 500ing every unauthenticated request while making the dev-auth fallback unreachable.
      //
      // Real session first; the dev-auth header stub is only ever a fallback, and is off entirely
      // outside local development. A session that exists but has no workspace THROWS ContextError
      // rather than returning null, so it cannot be silently downgraded onto the stub.
      const sessionCtx = await resolveSessionContext(req, res);
      // A session that was PRESENTED and rejected (expired, signed-out-everywhere, unknown token)
      // must not be quietly downgraded onto the dev-auth header stub. It used to be: the resolver
      // returns null for expiry, `?? resolveDevContext(req)` picked that up, and an expired cookie
      // plus forged x-cb-* headers authenticated — making expiry decorative wherever DEV_AUTH=1.
      // The stub exists for requests that presented NO session at all.
      ctx = sessionCtx ?? (hasSessionCookie(req) ? undefined : resolveDevContext(req));
    } catch (err) {
      if (err instanceof ContextError) {
        sendError(res, reqId, mapContextError(err));
        return;
      }
      throw err;
    }
    if (!ctx) {
      sendError(res, reqId, new OperationError('unauthenticated', 'no authenticated identity',
        'Sign in at /auth/google. Locally you can also POST /auth/dev-login (no Google project needed) — see docs/auth-setup.md.'));
      return;
    }

    // The per-principal budget used to be shed HERE, which meant it protected this route and nothing
    // else. It now lives at rung 0 of dispatchOp, so MCP (src/api/mcp.ts) and the CLI
    // (src/api/call.ts) are covered by the same meter (D94) — and this route's behaviour is
    // unchanged: same 429, same envelope, same retry-after, just decided one layer down.
    // `preAuthGuard` (300/min/IP, mounted app-wide at src/index.ts) still runs before any of this.
    const opName = String(req.params.op ?? '');
    const result = await dispatchOp(ctx, opName, req.body, { reqId });
    if (result.ok) {
      res.status(200).json({ ok: true, reqId: result.reqId, data: result.data });
    } else {
      // Read off the result rather than re-derived from a limiter here: the number and the decision
      // that produced it come from the same place, so they cannot drift apart.
      if (result.retryAfter !== undefined) res.setHeader('retry-after', String(result.retryAfter));
      res.status(result.status).json({ ok: false, reqId: result.reqId, error: result.error });
    }
  });

  // The web UI's fallback, if there is one. This exact position — after every /api route, before
  // the catch-all — is the whole reason MountApiOptions exists; see its doc comment.
  if (opts.webFallback) app.use(opts.webFallback);

  // Catch-all 404, registered after every route but BEFORE the error middleware. Without it an
  // unmatched path falls through to Express's default handler, which returns `Cannot POST /x` as
  // text/html — so a client that JSON.parse()s the body gets a syntax error instead of the closed
  // {ok:false, reqId, error} envelope this API promises everywhere else. The documented
  // dev-login-disabled case (404 when the route is not mounted) hit exactly this.
  app.use((req: Request, res: Response) => {
    sendError(res, requestId(req, res), new OperationError('not_found', 'not found',
      'GET /api/_ops lists available operations.'));
  });

  // Terminal error middleware (must be registered LAST). Body-parser errors (malformed / oversized
  // JSON) throw BEFORE the route runs, and any error escaping a route/dispatch lands here too — every
  // one is mapped to the same {ok:false, reqId, error} envelope, so no stack trace ever leaks to the
  // caller and the closed error contract holds even on the pre-route path.
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const reqId = requestId(req, res);
    const type = (err as { type?: string } | null)?.type;
    if (type === 'entity.parse.failed') {
      sendError(res, reqId, new OperationError('invalid_params', 'request body is not valid JSON'));
      return;
    }
    if (type === 'entity.too.large') {
      // The limit differs by route, so the message has to as well — it used to hardcode "100kb",
      // which became a lie for the upload route the moment that route got its own parser. An error
      // naming the wrong number sends someone shrinking a file that was never too big. Now derived
      // from the same function index.ts uses to decide which parser runs, so the two cannot drift.
      const limit = bodyLimitFor(req.path);
      sendError(res, reqId, new OperationError('payload_too_large', `request body exceeds the ${limit} limit`));
      return;
    }
    console.error(`[api_error] reqId=${reqId} ${req.method} ${req.path}`, err);
    sendError(res, reqId, new OperationError('internal_error', 'internal error',
      `Reference reqId ${reqId} in server logs.`));
  });
}
