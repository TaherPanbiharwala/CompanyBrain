// Boot: Express 5 app with /health + the M1 dispatch spine (/api/:op, /api/_ops).
import express from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config.ts';
import { appSql } from './db/client.ts';
import { mountApi } from './api/server.ts';
import { mountAuth } from './auth/routes.ts';
import { assertDevAuthSafe, assertDevLoginSafe } from './api/dev-auth.ts';
import { assertDeploymentSafe } from './boot.ts';
import { csrfGuard } from './auth/csrf.ts';

export const app = express();
// Behind a proxy req.ip is the proxy's address unless this is set, which would collapse the
// /auth/* rate limiter to one bucket for the whole fleet. Unset => never trust any hop.
if (config.TRUST_PROXY) {
  const hops = Number(config.TRUST_PROXY);
  app.set('trust proxy', Number.isFinite(hops) ? hops : config.TRUST_PROXY);
}
app.use(express.json({ limit: '100kb' })); // explicit body cap (review AM10)
// Express 5 has no cookie parsing of its own. Parsing ONLY — the oauth cookie carries its own HMAC.
app.use(cookieParser());
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

// A tiny index so hitting the root during setup says something useful instead of 404ing.
app.get('/', (_req, res) => {
  res.json({
    service: 'company-brain',
    sign_in: '/auth/google',
    ops: '/api/_ops',
    health: '/health',
  });
});

// Auth routes go BEFORE the api mount, so both land ahead of the terminal error middleware that
// mountApi registers last.
mountAuth(app);
mountApi(app);

if (import.meta.main) {
  // Print the EXACT redirect URI so it can be pasted into Google Cloud Console verbatim. A
  // mismatch here is the single most common OAuth setup failure (`redirect_uri_mismatch`).
  console.log(`[auth] register this redirect URI in Google Cloud Console: ${config.OIDC_REDIRECT_URI}`);
  // The TRUST_PROXY / https / secrets warnings that used to live here are now hard boot gates in
  // assertDeploymentSafe() above — a warning printed only when running as main is not a control.
  app.listen(config.PORT, () => {
    console.log(`company-brain listening on ${config.APP_BASE_URL} (port ${config.PORT})`);
  });
}
