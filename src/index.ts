// Boot: Express 5 app with /health + the M1 dispatch spine (/api/:op, /api/_ops).
import express from 'express';
import { config } from './config.ts';
import { appSql } from './db/client.ts';
import { mountApi } from './api/server.ts';
import { assertDevAuthSafe } from './api/dev-auth.ts';

export const app = express();
app.use(express.json({ limit: '100kb' })); // explicit body cap (review AM10)

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

// Fail-closed at import time (not just when run as main): any entrypoint that imports `app` and
// calls .listen() itself still trips the guard, so dev-auth can never be silently live in prod.
assertDevAuthSafe();

mountApi(app);

if (import.meta.main) {
  app.listen(config.PORT, () => {
    console.log(`company-brain listening on http://localhost:${config.PORT}`);
  });
}
