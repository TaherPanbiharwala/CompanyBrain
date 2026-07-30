// Boot: Express 5 app with /health + the M1 dispatch spine (/api/:op, /api/_ops).
import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import cookieParser from 'cookie-parser';
import { config } from './config.ts';
import { appSql } from './db/client.ts';
import { mountApi, UPLOAD_PATH } from './api/server.ts';
import { mountAuth } from './auth/routes.ts';
import { assertDevAuthSafe, assertDevLoginSafe } from './api/dev-auth.ts';
import { assertDeploymentSafe } from './boot.ts';
import { csrfGuard, preAuthGuard } from './auth/csrf.ts';
import {
  securityHeaders,
  mountWebStatic,
  spaFallback,
  assertWebBuildPresent,
  shouldUseViteDevServer,
  createViteDev,
} from './web.ts';

export const app = express();
// Behind a proxy req.ip is the proxy's address unless this is set, which would collapse the
// /auth/* rate limiter to one bucket for the whole fleet. Unset => never trust any hop.
if (config.TRUST_PROXY) {
  const hops = Number(config.TRUST_PROXY);
  app.set('trust proxy', Number.isFinite(hops) ? hops : config.TRUST_PROXY);
}
// Explicit body cap (review AM10), app-wide EXCEPT the one route that legitimately carries a file.
//
// The exemption is about ORDER, not size. This parser runs before preAuthGuard and csrfGuard, so a
// single 100kb cap here would either reject every upload outright, or — if simply raised — hand an
// unauthenticated flood a multi-megabyte JSON.parse per request at 300 req/min/IP, ahead of the very
// shed that exists to stop that. /api/ingest_file therefore parses its own body inside mountApi,
// AFTER both guards, where an oversized body has already had to get past the flood shed and CSRF.
const standardJson = express.json({ limit: '100kb' });
app.use((req, res, next) => (req.path === UPLOAD_PATH ? next() : standardJson(req, res, next)));
// Express 5 has no cookie parsing of its own. Parsing ONLY — the oauth cookie carries its own HMAC.
app.use(cookieParser());
// Coarse IP-keyed flood shed, BEFORE anything touches the database. Ordering is the whole point:
// the per-principal apiLimiter cannot run until resolveSessionContext has already spent a round trip
// on the cb_app pool, so it could never protect that pool from unauthenticated traffic. A flood of
// well-formed junk session cookies passes looksLikeToken and reaches the database; at ~10
// connections that starves every authenticated request. This sheds it from memory first.
// Security headers on EVERY response, before anything can answer. M5 Phase 0: this app now serves
// HTML that renders ingested document text and model output, on a cookie-authenticated origin with
// no CSRF token — so `script-src 'self'` is what stands between a stored-XSS payload and full
// authority over create_invite/delete_page. Mounted here, app-wide, for the same reason csrfGuard is:
// a router added later inherits it rather than having to remember.
app.use(securityHeaders);
app.use(preAuthGuard);
// CSRF for EVERY cookie-authenticated mutating request, app-wide — deliberately not inside either
// router. It sits after cookieParser (it needs to know whether a session cookie is present) and
// before both mounts, so /api/:op is covered and any router added later inherits it.
app.use(csrfGuard);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'company-brain', env: config.NODE_ENV });
});

app.get('/health/db', async (_req, res) => {
  try {
    const sql = appSql();
    const rows = await sql<{ ok: number }[]>`select 1 as ok`;
    res.json({ status: 'ok', db: rows[0]?.ok === 1 });
  } catch (err) {
    // Log detail server-side; return a generic body so an anonymous caller can't recon the DB.
    console.error('[health/db] check failed:', err);
    res.status(503).json({ status: 'error' });
  }
});

// Fail-closed at IMPORT time (not just when run as main): any entrypoint that imports `app` and
// calls .listen() itself still trips these, so neither identity bypass can be silently live in prod.
// This placement is a deliberate security property — do not move it behind import.meta.main.
assertDevAuthSafe();
assertDevLoginSafe();
assertDeploymentSafe();
// A deploy whose UI build step did not run would otherwise boot green — /health is pure memory —
// and then 404 every page. Same class as the gates above: silently wrong rather than obviously off.
assertWebBuildPresent();

// The service index MOVED here from `/` at M5 Phase 0, because the SPA now owns the root. Kept
// rather than deleted: it is what tells someone mid-setup that the server is up and where to go,
// and README/docs reference it.
app.get('/api', (_req, res) => {
  res.json({
    service: 'company-brain',
    sign_in: '/auth/google',
    ops: '/api/_ops',
    health: '/health',
    app: '/',
  });
});

// Vite runs in-process in dev (see createViteDev for why not a proxy on :5173). Gated on
// import.meta.main so that importing `app` — which every server test does — never starts a dev
// server; only a real `bun run dev` does.
//
// The http.Server is constructed HERE rather than by app.listen() because Vite needs it to attach
// the HMR websocket to, and that has to happen before the first request. Express's `app` is just a
// request handler, so building the server early and adding middleware after is fine — the handler
// is looked up per request, not captured at construction.
const httpServer = import.meta.main ? createHttpServer(app) : null;
const viteDev =
  httpServer && shouldUseViteDevServer() ? await createViteDev(httpServer) : null;

// Static assets ahead of the routers: a content-hashed chunk is public and should not walk the auth
// stack. express.static is mounted with index:false, so it answers only for files that exist and
// never decides who owns `/`.
if (viteDev) app.use(viteDev.assets);
else mountWebStatic(app);

// Auth routes go BEFORE the api mount, so both land ahead of the terminal error middleware that
// mountApi registers last.
mountAuth(app);
// webFallback is registered by mountApi AFTER every /api route and BEFORE its catch-all 404 — the
// only correct position, and one a caller cannot reach on its own. See MountApiOptions.
mountApi(app, { webFallback: viteDev ? viteDev.html : spaFallback() });

if (import.meta.main) {
  // Print the EXACT redirect URI so it can be pasted into Google Cloud Console verbatim. A
  // mismatch here is the single most common OAuth setup failure (`redirect_uri_mismatch`).
  console.log(`[auth] register this redirect URI in Google Cloud Console: ${config.OIDC_REDIRECT_URI}`);
  // The TRUST_PROXY / https / secrets warnings that used to live here are now hard boot gates in
  // assertDeploymentSafe() above — a warning printed only when running as main is not a control.
  // httpServer, not app.listen(): Vite's HMR websocket is already attached to this exact server,
  // so a second one would leave HMR pointing at a socket nothing listens on.
  httpServer!.listen(config.PORT, () => {
    console.log(`company-brain listening on ${config.APP_BASE_URL} (port ${config.PORT})`);
  });
}
