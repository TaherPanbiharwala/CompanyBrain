// REST transport for the dispatch spine. Extracts the transport slice from gbrain's serve-http.ts
// /mcp handler (auth → dispatch) under MIT — see NOTICE — adapted to REST + company-brain ctx.
// M1 auth is the dev-auth stub; M2 replaces resolveDevContext with the real session resolver.
import type { Express, Request, Response, NextFunction } from 'express';
import { ContextError } from '../core/context.ts';
import { operations } from './operations.ts';
import { buildToolDefs } from './tool-defs.ts';
import { dispatchOp } from './dispatch.ts';
import { mapContextError, OperationError } from './errors.ts';
import { apiLimiter } from '../auth/ratelimit.ts';
import { resolveDevContext } from './dev-auth.ts';
import { resolveSessionContext, hasSessionCookie } from '../auth/resolver.ts';

export function mountApi(app: Express): void {
  // Discovery: the same catalog MCP tools/list exposes, over REST (review AM8). Hidden ops excluded.
  app.get('/api/_ops', (_req: Request, res: Response) => {
    res.json({ ok: true, data: buildToolDefs(operations.filter((o) => !o.hidden)) });
  });

  app.post('/api/:op', async (req: Request, res: Response) => {
    const reqId = req.header('x-request-id') ?? crypto.randomUUID();
    res.setHeader('x-request-id', reqId);

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
        const oe = mapContextError(err);
        res.status(oe.status).json({ ok: false, reqId, error: oe.toWire() });
        return;
      }
      throw err;
    }
    if (!ctx) {
      res.status(401).json({
        ok: false,
        reqId,
        error: {
          code: 'unauthenticated',
          message: 'no authenticated identity',
          suggestion: 'Sign in at /auth/google. Locally you can also POST /auth/dev-login (no Google project needed) — see docs/auth-setup.md.',
        },
      });
      return;
    }

    // Throttle the EXPENSIVE surface, keyed on the principal now that we know it. `ask` runs a
    // hybrid search plus a paid model call and `ingest` embeds every chunk, so this is where a
    // runaway agent loop actually costs money — yet only the cheap pre-auth routes were limited.
    if (apiLimiter.hit(ctx.principal)) {
      const err = new OperationError('rate_limited', 'too many requests',
        'Slow down — this workspace has hit its per-minute operation budget.');
      res.setHeader('retry-after', String(apiLimiter.retryAfterSeconds(ctx.principal)));
      res.status(err.status).json({ ok: false, reqId, error: err.toWire() });
      return;
    }

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
    const existing = res.getHeader('x-request-id');
    const supplied = req.header('x-request-id');
    const reqId = (typeof existing === 'string' ? existing : undefined)
      ?? (supplied && supplied.length <= 200 ? supplied : crypto.randomUUID());
    res.setHeader('x-request-id', reqId);
    res.status(404).json({
      ok: false,
      reqId,
      error: { code: 'not_found', message: 'not found', suggestion: 'GET /api/_ops lists available operations.' },
    });
  });

  // Terminal error middleware (must be registered LAST). Body-parser errors (malformed / oversized
  // JSON) throw BEFORE the route runs, and any error escaping a route/dispatch lands here too — every
  // one is mapped to the same {ok:false, reqId, error} envelope, so no stack trace ever leaks to the
  // caller and the closed error contract holds even on the pre-route path.
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    const existing = res.getHeader('x-request-id');
    const reqId = (typeof existing === 'string' ? existing : undefined) ?? req.header('x-request-id') ?? crypto.randomUUID();
    if (res.headersSent) return next(err);
    res.setHeader('x-request-id', reqId);
    const type = (err as { type?: string } | null)?.type;
    if (type === 'entity.parse.failed') {
      res.status(400).json({ ok: false, reqId, error: { code: 'invalid_params', message: 'request body is not valid JSON' } });
      return;
    }
    if (type === 'entity.too.large') {
      res.status(413).json({ ok: false, reqId, error: { code: 'payload_too_large', message: 'request body exceeds the 100kb limit' } });
      return;
    }
    console.error(`[api_error] reqId=${reqId} ${req.method} ${req.path}`, err);
    res.status(500).json({
      ok: false,
      reqId,
      error: { code: 'internal_error', message: 'internal error', suggestion: `Reference reqId ${reqId} in server logs.` },
    });
  });
}
