# company-brain

A multi-tenant SaaS knowledge brain: upload → ask → cited, permission-scoped answer.
Private/commercial. Built fork-and-narrow on [gbrain](https://github.com/garrytan/gbrain)
(MIT) — see [`NOTICE`](NOTICE) and [`DECISIONS.md`](DECISIONS.md).

## Status

Built: **M0 (foundations)** + **M1 (the contract spine)** — an ops-as-data registry dispatched over
REST (`/api/:op`) and stdio MCP. Roadmap and the multi-lens reviews live in [`docs/plan.md`](docs/plan.md);
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

## Calling operations (M1)

Every capability is an `Operation` exposed over three surfaces. Until real auth lands (M2), identity
is supplied explicitly.

```bash
# 1. Trusted local CLI (no HTTP, no auth surface) — fastest way to see an op work:
CB_CLI_PRINCIPAL=<uuid> CB_CLI_WORKSPACE=<uuid> CB_CLI_ROLE=owner bun run call whoami

# 2. HTTP (dev-auth stub; DEV only, never production):
DEV_AUTH=1 bun run dev            # in another shell
curl -s -XPOST localhost:3000/api/whoami \
  -H 'content-type: application/json' \
  -H 'x-cb-principal: <uuid>' -H 'x-cb-workspace: <uuid>' -H 'x-cb-role: owner' -d '{}'
curl -s localhost:3000/api/_ops   # machine-readable catalog of ops + JSON-Schemas

# 3. stdio MCP (for AI agents): CB_MCP_PRINCIPAL/WORKSPACE/ROLE in the env, then `bun run mcp`.
```

Every request is logged as one **shape-only** JSON line (declared param key names + a 1KB-bucketed
size + outcome code + a `reqId`) — never a param value. The `reqId` is also returned in every
response, so an `internal_error` can be traced to its server log.

## Adding an operation (5 minutes)

In `src/api/operations.ts`, add a `defineOp({...})` and register it in the `operations` array:

```ts
const get_page = defineOp({
  name: 'get_page',
  description: 'Fetch a page by slug in the current workspace.', // imperative; agents read this
  params: z.object({ slug: z.string() }),   // zod → validation + MCP inputSchema + shape redaction
  requiredRole: 'member',                    // owner ⊃ admin ⊃ member (default member)
  mutating: false,
  handler: async (ctx, params) =>            // params is typed { slug: string }
    withScopedTx(ctx, (tx) => tx`select * from pages where slug = ${params.slug}`), // RLS scopes it
});
```

That's it — it's live on `/api/get_page`, in `/api/_ops`, and in MCP `tools/list` automatically,
with role-gating, validation, the error envelope, and shape-only logging applied by dispatch. Any
`chat()`/`embed()` must run OUTSIDE the `withScopedTx` callback (never hold a pooled connection across
a model call — DECISIONS D6).

## Layout

- `src/db/` — `schema.sql` (immutable baseline: tenancy + identity + RLS + integrity FKs),
  `migrations/` (post-baseline `NNNN_*.sql`; see its README), `client.ts` (non-BYPASSRLS pool +
  GUC tx), `migrate.ts` (checksummed runner)
- `src/core/` — `context.ts` (fail-closed `OperationContext` + grants keyring)
- `src/ai/` — `router.ts` (the one door for every model call)
- `src/api/` — the **contract spine** (M1): `operations.ts` (ops-as-data + registry), `dispatch.ts`
  (validate → role-check → run → shape-only log), `roles.ts`, `errors.ts`, `redact.ts`, `server.ts`
  (`/api/:op` + `/api/_ops`), `tool-defs.ts` + `mcp.ts` (stdio MCP), `dev-auth.ts` (temporary; M2
  replaces it), `call.ts` (local CLI)
- `test/` — no-DB unit (`roles`, `errors`, `redact`, `dispatch`, `dev-auth`, `tool-defs`, `registry`,
  `context`, `router`); env-gated live (`rls-smoke`, `api`); `leak-canary.test.ts` is sacred (M3)
