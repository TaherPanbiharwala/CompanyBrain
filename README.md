# company-brain

A multi-tenant SaaS knowledge brain: upload → ask → cited, permission-scoped answer.
Private/commercial. Built fork-and-narrow on [gbrain](https://github.com/garrytan/gbrain)
(MIT) — see [`NOTICE`](NOTICE) and [`DECISIONS.md`](DECISIONS.md).

## Status

Built: **M0 (foundations)**, **M1 (the contract spine)**, **A17 (the answer-quality spike)**,
**M2 (identity — Google OIDC)**, **M3 (the brain loop — multi-format ingest, page lifecycle,
four-arm hybrid search)**, **M4 (enforcement + doctor)** and **M5a (the web app)**.

Open `/` and you get a real UI: sign in with Google, create or join a workspace, upload a document
(paste or file), ask a question, and read a cited answer with a scope badge on every source. Every
request resolves its tenant from a verified membership row, and Postgres RLS — not application
code — is what scopes the rows.

Still to come in **M5b**: teams, the member/operator admin surfaces, conversations, and MCP over
HTTP. See [`docs/screens.md`](docs/screens.md) for the screen inventory. Roadmap and the multi-lens reviews live in
[`docs/plan.md`](docs/plan.md); decisions in [`DECISIONS.md`](DECISIONS.md); auth setup in
[`docs/auth-setup.md`](docs/auth-setup.md); retrieval/hallucination evaluation in
[`docs/eval-rag.md`](docs/eval-rag.md).

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
2. Copy **three** connection strings into `.env` (see `.env.example`). Three, not two — M2 added a
   dedicated least-privilege lane, and `bun run migrate` refuses to start without it:

   | Variable | Pooler | User | Role it is |
   |---|---|---|---|
   | `DATABASE_URL` | transaction, 6543 | `cb_app.<ref>` | the per-request tenant role (non-BYPASSRLS) |
   | `DATABASE_AUTH_URL` | transaction, 6543 | `cb_auth.<ref>` | login/onboarding writes only |
   | `DATABASE_ADMIN_URL` | session, 5432 | `postgres.<ref>` | migrations only |

   Set `CB_APP_DB_PASSWORD` and `CB_AUTH_DB_PASSWORD` to the passwords you want those two roles to
   have — `migrate` creates the roles with them, so they must match the passwords embedded in the
   URLs above. (The direct `db.<ref>.supabase.co` host is IPv6-only without the paid add-on; use the
   pooler.)

```bash
cp .env.example .env      # fill in all three Supabase strings + both role passwords + API keys
bun install
bun run migrate           # (as postgres) enables pgvector, creates cb_app + cb_auth, applies schema.sql + every migration, sets the grant matrix
bun run doctor            # 73 checks on the security posture — green before you trust anything
bun run build:web         # builds the SPA into web/dist
bun run dev               # boots Express + Vite in-process; open http://localhost:3000
```

`build:web` is optional for a loopback dev run (Vite serves the app from source, with HMR) but
**mandatory for any deploy**: `assertWebBuildPresent()` in `src/index.ts` refuses to boot when
`APP_BASE_URL` is not loopback and `web/dist/index.html` is missing. A deploy whose UI build step did
not run would otherwise come up green — `/health` is pure memory — and 404 every page.

`migrate` connects as `postgres` to create the two app roles and the schema; the app then connects
as `cb_app` so Row-Level Security actually applies (a table owner or a `BYPASSRLS` role would skip
it), and as `cb_auth` for the pre-authentication login path.

Full runbook, including the Google Cloud OAuth client and the local dev-login shortcut that needs no
Google project at all: **[docs/auth-setup.md](docs/auth-setup.md)**.

## Signing in (M2)

Browsers authenticate with Google; machine callers stay trusted-local and env-identified. **No
Google Cloud project is needed for local development** — see [`docs/auth-setup.md`](docs/auth-setup.md).

```bash
bun run migrate && bun run doctor   # doctor asserts the whole security posture; must be green
bun run start

# Local path (DEV_AUTH=1 DEV_LOGIN=1, loopback only — the app refuses to boot otherwise).
# All THREE calls are required: on a fresh DB you land workspace-less by design.
curl -s -c c.txt -XPOST localhost:3000/auth/dev-login \
  -H 'content-type: application/json' -d '{"email":"you@example.com"}'
curl -s -b c.txt -c c.txt -XPOST localhost:3000/auth/workspaces \
  -H 'content-type: application/json' -d '{"name":"My Workspace"}'
curl -s -b c.txt -XPOST localhost:3000/api/whoami -H 'content-type: application/json' -d '{}'

# Real Google sign-in (needs GOOGLE_CLIENT_ID/SECRET): open /auth/google in a browser.
```

## Calling operations

Every capability is an `Operation` exposed over three surfaces.

```bash
# 1. Trusted local CLI. The env names the principal + workspace; the DATABASE supplies the role
#    (assertMembership), so there is no CB_CLI_ROLE to get wrong.
CB_CLI_PRINCIPAL=<uuid> CB_CLI_WORKSPACE=<uuid> bun run call whoami

# 2. HTTP with a real session cookie (see "Signing in" above).
curl -s localhost:3000/api/_ops   # machine-readable catalog of ops + JSON-Schemas

# 3. stdio MCP (for AI agents): CB_MCP_PRINCIPAL/WORKSPACE in the env, then `bun run mcp`.
```

M2 authenticates **browsers**. Machine callers remain trusted-local; there is no remote machine
credential until M3.

Every request is logged as one **shape-only** JSON line (declared param key names + a 1KB-bucketed
size + outcome code + a `reqId`) — never a param value. The `reqId` is also returned in every
response, so an `internal_error` can be traced to its server log.

## Adding an operation (5 minutes)

In `src/api/operations.ts`, add a `defineOp({...})` and register it in the `operations` array:

```ts
const page_stats = defineOp({
  name: 'page_stats',
  description: 'Return chunk counts for a page by slug.', // imperative; agents read this
  params: z.object({ slug: z.string() }),   // zod → validation + MCP inputSchema + shape redaction
  requiredRole: 'member',                    // owner ⊃ admin ⊃ member (default member)
  mutating: false,
  handler: async (ctx, params) =>            // params is typed { slug: string }
    withScopedTx(ctx, (tx) => tx`select count(*) from content_chunks c join pages p on p.id = c.page_id where p.slug = ${params.slug}`), // RLS scopes it
});
```

That's it — it's live on `/api/page_stats`, in `/api/_ops`, and in MCP `tools/list` automatically,
with role-gating, validation, the error envelope, and shape-only logging applied by dispatch. Any
`chat()`/`embed()` must run OUTSIDE the `withScopedTx` callback (never hold a pooled connection across
a model call — DECISIONS D6).

## Layout

- `src/db/` — `schema.sql` (immutable baseline: tenancy + identity + RLS + integrity FKs),
  `migrations/` (post-baseline `NNNN_*.sql`; see its README), `client.ts` (non-BYPASSRLS pool +
  GUC tx), `migrate.ts` (checksummed runner)
- `src/core/` — `context.ts` (fail-closed `OperationContext` + grants keyring)
- `src/auth/` — **identity** (M2): `google.ts` (OIDC relying party), `resolver.ts` (session → tenant
  context; the D25 chokepoint), `session.ts` (tokens, hashing, cookies), `workspaces.ts` (onboarding
  + domain claim), `invites.ts`, `membership.ts`, `routes.ts` (8 routes), `csrf.ts`, `ratelimit.ts`,
  `normalize.ts`, `blocklist.ts`
- `src/boot.ts` — deployment-shape gates that REFUSE to start (proxy/https/secrets). A warning that
  fires only under `import.meta.main` is not a control, and the shape it warned about was the default.
- `src/ai/` — `router.ts` (the one door for every model call)
- `src/ingest/` — **A17**: `chunk.ts` (recursive delimiter-aware chunker), `import.ts` (page →
  chunks → embeddings; derives `acl` from `scope`, so the label is not decorative)
- `src/search/` — **A17**: `hybrid.ts` (keyword + vector arms fused by RRF), `eval-score.ts`
  (hit@1 / hit@3 / MRR — the numbers the A17 go/no-go rests on)
- `src/answer/` — **A17**: `prompt.ts` (nonce-framed evidence blocks; untrusted page content can
  never forge a frame or an attribution), `answer.ts` (cited answer, citations clamped to range)
- `src/api/` — the **contract spine** (M1): `operations.ts` (ops-as-data + registry), `dispatch.ts`
  (lookup → role-check → validate → run → shape-only log — authz BEFORE validating attacker-chosen
  input, deliberately), `roles.ts`, `errors.ts`, `redact.ts`, `reqid.ts`, `server.ts`
  (`/api/:op` + `/api/_ops`), `tool-defs.ts` + `mcp.ts` (stdio MCP), `dev-auth.ts` (the header stub,
  now only a local fallback behind the session resolver), `call.ts` (local CLI)
- `src/db/doctor.ts` — `bun run doctor`: 69 assertions + 4 snapshot fixtures (73 checks) over the grant matrix,
  RLS policies and the `SECURITY DEFINER` surface. The twelve cross-tenant defects closed during M2's
  review were closed by GRANTs and POLICIES, which no type system or unit test can see; this is what
  makes them fail loudly if they ever drift.
- `test/` — no-DB unit (`roles`, `errors`, `redact`, `dispatch`, `dev-auth`, `dev-login-gate`,
  `csrf-ratelimit`, `normalize`, `session`, `google` incl. an in-process fake OIDC issuer,
  `tool-defs`, `registry`, `context`, `router`, `chunk`, `rrf`); env-gated live (`rls-smoke`, `api`,
  `ingest`, `hybrid`, `answer`, `m2-auth`); `leak-canary.test.ts` is sacred (M3)
