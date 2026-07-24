# company-brain

A multi-tenant SaaS knowledge brain: upload → ask → cited, permission-scoped answer.
Private/commercial. Built fork-and-narrow on [gbrain](https://github.com/garrytan/gbrain)
(MIT) — see [`NOTICE`](NOTICE) and [`DECISIONS.md`](DECISIONS.md).

## Status

Building **M0 (foundations)**. Roadmap and the multi-lens review live in [`docs/plan.md`](docs/plan.md);
decisions in [`DECISIONS.md`](DECISIONS.md).

## The one thing that must never break

Cross-tenant isolation. Every content/tenancy row carries `workspace_id` (the identity plane —
`principals`, `sessions` — is global with self-scoped RLS); the app connects as a **non-BYPASSRLS**
Postgres role so Row-Level Security actually applies; the request context is **fail-closed** (a
missing/invalid `workspace_id`/grants throws, never reads all tenants); and integrity FKs make a
mis-stamped tenant on a chunk, or a session pointed at a non-membership, impossible at the DB. The
leak-canary test (M3) proves zero cross-tenant bleed and runs in CI forever; `test/rls-smoke.test.ts`
is the M0 down payment on it.

## Local dev (Supabase)

1. Create a Supabase project (it ships Postgres + pgvector).
2. Copy connection strings into `.env` (see `.env.example`): the **transaction pooler** URL
   (port 6543, user `cb_app.<ref>`) as `DATABASE_URL`, and the **session pooler** URL (port 5432,
   user `postgres.<ref>`) as `DATABASE_ADMIN_URL`. Set `CB_APP_DB_PASSWORD` to the password you want
   `cb_app` to use. (The direct `db.<ref>.supabase.co` host is IPv6-only without the paid add-on;
   use the pooler.)

```bash
cp .env.example .env      # fill in Supabase strings + API keys
bun install
bun run migrate           # (as postgres) enables pgvector, creates the non-BYPASSRLS cb_app role, applies schema.sql
bun run dev               # boots Express; GET /health -> {"status":"ok"}
```

`migrate` connects as `postgres` to create the `cb_app` role and the schema; the app then connects
as `cb_app` so Row-Level Security actually applies (a table owner or a `BYPASSRLS` role would skip it).

## Layout

- `src/db/` — `schema.sql` (immutable baseline: tenancy + identity + RLS + integrity FKs),
  `migrations/` (post-baseline `NNNN_*.sql`; see its README), `client.ts` (non-BYPASSRLS pool +
  GUC tx), `migrate.ts` (checksummed runner)
- `src/core/` — `context.ts` (fail-closed `OperationContext` + grants keyring)
- `src/ai/` — `router.ts` (the one door for every model call)
- `src/api/` — dispatch spine + `/api/:op` (M1); MCP transport (M3)
- `test/` — `context.test.ts`, `router.test.ts` (no DB); `rls-smoke.test.ts` (env-gated, live);
  `leak-canary.test.ts` is sacred (M3)
