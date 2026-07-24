// M0 boot: minimal Express 5 app with /health. The dispatch spine + /api/:op land at M1.
import express from 'express';
import { config } from './config.ts';
import { appSql } from './db/client.ts';

export const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'company-brain', env: config.NODE_ENV });
});

app.get('/health/db', async (_req, res) => {
  try {
    const sql = appSql();
    const rows = await sql<{ ok: number }[]>`select 1 as ok`;
    res.json({ status: 'ok', db: rows[0]?.ok === 1 });
  } catch (err) {
    // Log detail server-side; return a generic body so an anonymous caller can't recon the DB
    // host/role/SQL from the error string (review sec S3 / adv #7).
    console.error('[health/db] check failed:', err);
    res.status(503).json({ status: 'error' });
  }
});

if (import.meta.main) {
  app.listen(config.PORT, () => {
    console.log(`company-brain listening on http://localhost:${config.PORT}`);
  });
}
