// REST transport for the dispatch spine. Extracts the transport slice from gbrain's serve-http.ts
// /mcp handler (auth → dispatch) under MIT — see NOTICE — adapted to REST + company-brain ctx.
// M1 auth was the dev-auth stub. M2 did NOT replace it — it DEMOTED it to a local-only fallback
// reachable only when no session cookie was presented at all (D45). Line ~39 is where that holds.
import type { Express, Request, Response, NextFunction } from 'express';
import { ContextError } from '../core/context.ts';
import { operations } from './operations.ts';
import { buildToolDefs } from './tool-defs.ts';
import { dispatchOp } from './dispatch.ts';
import { mapContextError, OperationError } from './errors.ts';
import { sendError, shedIfLimited } from './envelope.ts';
import { apiLimiter } from '../auth/ratelimit.ts';
import { requestId } from './reqid.ts';
import { resolveDevContext } from './dev-auth.ts';
import { resolveSessionContext, hasSessionCookie } from '../auth/resolver.ts';

export function mountApi(app: Express): void {
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

    // Throttle the EXPENSIVE surface, keyed on the principal now that we know it. `ask` runs a
    // hybrid search plus a paid model call and `ingest` embeds every chunk, so this is where a
    // runaway agent loop actually costs money — yet only the cheap pre-auth routes were limited.
    if (shedIfLimited(apiLimiter, ctx.principal, res, reqId,
      'Slow down — this workspace has hit its per-minute operation budget.')) return;

    const opName = String(req.params.op ?? '');
    const result = await dispatchOp(ctx, opName, req.body, { reqId });
    if (result.ok) {
      res.status(200).json({ ok: true, reqId: result.reqId, data: result.data });
    } else {
      res.status(result.status).json({ ok: false, reqId: result.reqId, error: result.error });
    }
  });

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
      sendError(res, reqId, new OperationError('payload_too_large', 'request body exceeds the 100kb limit'));
      return;
    }
    console.error(`[api_error] reqId=${reqId} ${req.method} ${req.path}`, err);
    sendError(res, reqId, new OperationError('internal_error', 'internal error',
      `Reference reqId ${reqId} in server logs.`));
  });
}
