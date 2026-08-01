// Boot: Express 5 app with /health + the M1 dispatch spine (/api/:op, /api/_ops).
import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import { config } from './config.ts';
import { appSql } from './db/client.ts';
import { mountApi, parsesOwnBody, STANDARD_BODY_LIMIT } from './api/server.ts';
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
// ── Middleware order. Every line below is load-bearing. ──────────────────────
//
// securityHeaders and preAuthGuard sit ABOVE the body parser, and that ordering was WRONG until the
// M5a review. A body-parser throw (entity.too.large, entity.parse.failed) calls next(err), which
// skips every remaining NON-error layer and lands straight on mountApi's terminal error middleware.
// With these mounted below, a 413 shipped with no CSP, no nosniff and no X-Frame-Options while the
// comment on securityHeaders claimed "EVERY response" — verified: a 200KB body to /api/whoami
// returned 413 with content-security-policy: null. The shed was skipped on that path too, so
// oversized and malformed bodies were entirely unmetered.
//
// Hoisting costs nothing: both are pure in-memory work with no dependency on a parsed body or on
// cookies.
app.use(securityHeaders);
app.use(preAuthGuard);

// gzip, above everything that produces a body.
//
// Measured on a real build: index.js is 221,326 bytes and index.css 12,412 — 233,738 shipped raw on
// every cold load, against 70,668 gzipped. 3.3x, and Vite's own build report already prints the
// gzip number next to the raw one, so the saving was being computed and discarded. express.static
// never compresses on its own and nothing else set Content-Encoding anywhere in src/.
//
// Above the routers rather than beside the static mount, so JSON envelopes get it too — an `ask`
// response carries the answer plus every retrieved chunk's text, which is the largest JSON the API
// returns.
app.use(compression());

// Explicit body cap (review AM10), app-wide EXCEPT the routes that legitimately carry a document.
//
// The exemption is about ORDER, not size. A single 100kb cap here would either reject every upload
// outright or, if simply raised, hand a flood a multi-megabyte JSON.parse per request. /api/ingest,
// /api/replace_page and /api/ingest_file therefore parse their own bodies inside mountApi, behind
// the shed above and behind requireSessionCookie — see bodyLimitFor().
const standardJson = express.json({ limit: STANDARD_BODY_LIMIT });
app.use((req, res, next) => (parsesOwnBody(req.path) ? next() : standardJson(req, res, next)));

// Express 5 has no cookie parsing of its own. Parsing ONLY — the oauth cookie carries its own HMAC.
app.use(cookieParser());

// CSRF for EVERY cookie-authenticated mutating request, app-wide — deliberately not inside either
// router. It sits after cookieParser (it needs to know whether a session cookie is present) and
// before both mounts, so /api/:op is covered and any router added later inherits it.
//
// NOTE it is a no-op for a request carrying NO session cookie that is not targeting /auth/ — an
// unauthenticated caller has no ambient authority to abuse. That is why the large per-route parsers
// cannot rely on it, and use requireSessionCookie instead.
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
// Vite's assets mount ABOVE nothing in production (mountWebStatic is already after the guards), but
// in DEV middleware mode serves every source module as its own request: ~13 files in web/src plus
// /@vite/client, /@react-refresh, the Tailwind module and several prebundled dep chunks — roughly 20
// requests per full reload, each spending one of preAuthGuard's 300/min/IP. That puts a reload loop
// at ~15/minute before the shed fires, and when it fires the developer gets a JSON 429 where a module
// should be: a white screen, for 60 seconds. HMR avoids most full reloads, so it bites during the
// config and Tailwind edits that force one.
//
// Dev-only by construction: viteDevActive is set exclusively by createViteDev, which is itself gated
// on import.meta.main and isDevEnv, so this cannot widen the production surface.
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
