// REST transport for the dispatch spine. Extracts the transport slice from gbrain's serve-http.ts
// /mcp handler (auth → dispatch) under MIT — see NOTICE — adapted to REST + company-brain ctx.
// M1 auth is the dev-auth stub; M2 replaces resolveDevContext with the real session resolver.
import type { Express, Request, Response, NextFunction } from 'express';
import { ContextError } from '../core/context.ts';
import { operations } from './operations.ts';
import { buildToolDefs } from './tool-defs.ts';
import { dispatchOp } from './dispatch.ts';
import { mapContextError } from './errors.ts';
import { resolveDevContext } from './dev-auth.ts';

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
      ctx = resolveDevContext(req);
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
          suggestion: 'Dev: set DEV_AUTH=1 and x-cb-principal/x-cb-workspace headers. Real auth lands at M2.',
        },
      });
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
