# DECISIONS.md

One line per irreversible or load-bearing choice. Newest context at the bottom of each
section. Full rationale + the multi-lens `/autoplan` review live in the plan doc at
`~/.claude/plans/velvety-crafting-pumpkin.md`.

## Product / strategy

- **D0 — Category:** multi-tenant SaaS "company brain" (YC RFS), India-first, Google-centric,
  invite-driven, demo-first then design-partner-driven. (2026-07-23)
- **D0.1 — Open (founder):** default upload scope = **workspace** vs **private** — resolved as
  "not private-alone" (workspace-default + privacy toggle, or private + forced share-nudge).
  Pending founder's final product call.
- **D0.2 — Open (founder):** run 5-10 discovery conversations + pick a sharp India vertical wedge,
  ideally gating the start of M0. Not a build task.

## Architecture / tenancy

- **D1 — Pooled multi-tenant, RLS from row zero.** One shared Postgres. Every content + **tenancy**
  table carries `workspace_id uuid NOT NULL`; ACL-bearing tables also carry `scope text`,
  `acl text[] NOT NULL`, `owner_principal text`; row visible iff `acl && grants`. The **identity
  plane** (`principals`, `sessions`) is **global** (a person spans workspaces) with self-scoped RLS,
  so it carries no `workspace_id` (`sessions.active_workspace_id` is a nullable, FK-checked pointer,
  not a tenancy column). (Reaffirmed at the `/autoplan` gate over a silo alternative.) (2026-07-23)
- **D2 — Fail closed, never `{}`.** A request with no resolvable `workspace_id`/grants THROWS.
  We do not copy gbrain's `sourceScopeOpts` `return {}` (unfiltered) fallback. (2026-07-23)
- **D3 — `workspace_id` is load-bearing in constraints from migration 1:** `UNIQUE(workspace_id,
  slug)`, `UNIQUE(workspace_id, idempotency_key)`, dedup/cache/rate-lease keys all carry it.
- **D4 — Denormalize `workspace_id` (+ `acl`) onto `content_chunks`, `tags`, `links`** — never
  transitive via `page_id` (RLS can't afford a JOIN on the HNSW hot path). (2026-07-23)
- **D5 — Enforcement phases in, columns don't:** app-resolver M0 → per-row `acl && grants` in
  engine queries M3 → **bare `workspace_id`-equality RLS pulled forward to M0/M2** (not M4) →
  `acl && grants` RLS refinement M4 → team/role grants M5. Non-BYPASSRLS app role from day 1.
  (workspace-equality RLS pulled forward per `/autoplan` UC3.) (2026-07-23)
- **D6 — Per-request tx `SET LOCAL` GUC discipline:** carry `app.workspace` / `app.grants` via
  tx-local `set_config(..., true)`; the tx wraps DB work ONLY, never the LLM call (pool
  exhaustion); `prepare:false` behind a transaction pooler. **RLS policies MUST read
  `NULLIF(current_setting('app.x', true), '')::uuid`** — a custom GUC's reset value becomes `''`
  (not NULL) once SET in a session, and transaction-pooler backends are reused, so an unscoped
  query on a reused backend reads `''` and a bare `''::uuid` cast aborts the query. `NULLIF` maps
  unset/`''` to NULL → row hidden (fail-closed). The M4 `acl && grants` policies must follow the
  same pattern. (per `/autoplan` A8/A11 + M0 `/review` adv #2) (2026-07-23)
- **D7 — Isolation lives in the DB (RLS); app-layer is defense-in-depth** — the inverse of gbrain.

## Build approach

- **D8 — Fork gbrain, delete-down to the SaaS seams** (supersedes "port patterns, don't fork").
  The engine (chunkers, RRF search, dedup, queue, gateway, link-extraction, dispatch spine) is
  **inherited** from gbrain at M1/M3 with attribution (see `NOTICE`); net-new code is reserved for
  the identity/tenancy seams. MIT lets us keep company-brain closed-source + commercial; the only
  obligation is the `NOTICE` file. (per `/autoplan` gate) (2026-07-23)
- **D9 — M0 is net-new scaffolding** (gbrain has no tenancy schema, no fail-closed context, no
  non-BYPASSRLS setup, no Express `/api` server). Engine files are vendored starting at M1/M3.

## Identity / auth

- **D10 — Roll-your-own Google OIDC** (relying-party login, hashed sessions + refresh rotation,
  workspaces, invites, keyring resolver). Chosen over managed auth for the India data-residency
  pitch. Highest blast radius → mandates the OperationError/auth-code taxonomy (M1), a 2-tenant
  leak-canary stub at M2, and identity-table RLS + enumeration test. (2026-07-23)
- **D11 — Workspace CREATE decoupled from domain AUTO-JOIN:** any verified Google login can create
  a personal workspace; the public-domain blocklist blocks domain auto-join only (so Gmail-first
  founders aren't locked out). Invites match on the Google verified email/`sub` + Gmail
  normalization (dots/`+`/case). (per `/autoplan` A13/A14) (2026-07-23)

## AI / retrieval

- **D12 — One door for every model call** (`src/ai/router.ts`): OpenRouter, AsyncLocalStorage
  per-workspace (cache key includes workspace/api-key). ZDR as a **per-workspace toggle**
  (cheapest provider default for the demo), not a hard M0 default. (per `/autoplan` T4) (2026-07-23)
- **D12.1 — Chat model resolved: DeepSeek via OpenRouter.** Founder ruled out **Anthropic** (too
  expensive) and **OpenAI's chat models**; chose **DeepSeek V4** instead. `CHAT_MODEL =
  openrouter:deepseek/deepseek-v4-flash` (cheap/default — every `chat()` call uses this unless a
  caller passes `model` explicitly); `FRONTIER_MODEL = openrouter:deepseek/deepseek-v4-pro`
  (reserved for heavier synthesis, e.g. M7 compiled-truth). Both slugs verified live against
  OpenRouter's public `/models` endpoint. Does **not** affect embeddings — OpenAI
  `text-embedding-3-small` (D13) stays locked; this is chat only. (2026-07-24)
- **D13 — Embeddings: OpenAI `text-embedding-3-small`, 1536 dims.** Gates the `vector(1536)` column
  + HNSW index. Single global `vector(N)` forecloses per-tenant embedders (documented constraint;
  revisit with a multi-column pattern if per-tenant embedders are needed). (2026-07-23)
- **D14 — pgvector ≥ 0.8** required (`hnsw.iterative_scan` to avoid filtered-HNSW recall collapse
  under tenant-selective filters). Gates the M0 docker image + schema. (per `/autoplan` A7) (2026-07-23)
- **D15 — Keep the reranker seam in v0** + a small answer-quality eval set as a v0 exit criterion
  alongside the leak canary. (per `/autoplan` A18) (2026-07-23)

## Quality / ops

- **D16 — The leak-canary test is sacred:** lands at M3 (+ a 2-tenant stub at M2), runs in CI
  forever, never skipped to move faster. Cases: cross-tenant, intra-workspace-private,
  identity-table enumeration, GUC-bleed concurrency, filtered-HNSW recall.
- **D17 — Every production bug adds a `doctor.ts` check.**
- **D18 — Per-workspace fail-closed spend cap by M5** (not M8); port gbrain's `withBudgetTracker`.
  (per `/autoplan` A15) (2026-07-23)
- **D19 — Agent surface (MCP) is in v0:** a thin stdio `tools/list`+`tools/call` transport reusing
  the M1 dispatch spine + a zod→JSON-Schema step. (per `/autoplan` UC4) (2026-07-23)
- **D20 — Honest schedule:** v0 (M0-M5) re-baselined to ~11-13 weeks solo; week-3 re-plan
  checkpoint on M0-M2 actuals. (per `/autoplan` A21) (2026-07-23)

## Stack

- **D21 — Stack:** Bun + TypeScript (strict) · Express 5 · Postgres + pgvector via `postgres.js`
  (raw SQL) · zod for op schemas · Google OIDC (`openid-client`) · OpenRouter for chat · Vite +
  React + Tailwind SPA served by the same Express · Railway/Fly single instance for the demo,
  GCP Mumbai (Cloud Run) as the eventual prod target.
- **D22 — Database = Supabase** (managed Postgres + pgvector), no local Docker. The app connects as
  a dedicated **non-BYPASSRLS `cb_app` role** (created by `bun run migrate`) via the **transaction
  pooler** (`prepare:false`, SSL); migrations run as the `postgres` owner via the **session pooler**
  (port 5432 on the pooler host — the direct `db.<ref>.supabase.co` host is IPv6-only without the
  paid IPv4 add-on and fails to resolve on IPv4-only networks). The pooler's transaction mode is
  exactly what the per-request `SET LOCAL` GUC pattern (D6) needs. (2026-07-23, supersedes the
  docker-compose local DB.)
- **D23 — Migration conventions.** `schema.sql` is an **immutable applied baseline** (the runner
  content-checksums applied files and fails on drift); post-baseline changes go to
  `src/db/migrations/NNNN_*.sql` (zero-padded, numeric-ordered). One transaction per file, recorded
  atomically. **Forward-only**; the rollback path is Supabase **PITR/backups** (confirm they're
  enabled). Non-transactional DDL (`CREATE INDEX CONCURRENTLY` on populated tables) uses the
  `-- migrate:no-transaction` pragma and must be idempotent. Adding NOT NULL to a populated table =
  expand→backfill(batched)→contract. New tables ship their RLS `ENABLE`+policy in the same file
  (Supabase auto-RLS enables RLS with no policy = default-deny). (per M0 `/review`) (2026-07-23)
- **D24 — `doctor.ts` checks (built at M4).** Assert: `cb_app` is `NOBYPASSRLS`; every
  cb_app-privileged `public` table has RLS enabled; no table is RLS-enabled-with-zero-policies;
  `content_chunks.embedding` dimension === `EMBEDDING_DIM`. (per M0 `/review` sec S2, data-mig D7/D8)
- **D25 — Deferred tenancy hardening.** **M2:** the keyring resolver must derive `app.workspace`
  only from a verified `workspace_members` row, never raw request input (the sessions FK is the DB
  backstop); a dedicated least-privilege **`cb_auth`** role for pre-auth lookups (so they don't run
  on the RLS-bypassing owner); column-level `GRANT UPDATE(name, updated_at)` on `principals` so
  profile writes can't rewrite `google_sub`/`email`. **M2-M5:** writes to `acl_grants` /
  `workspace_members` / `teams` route through the admin/auth connection or gain admin-only
  `WITH CHECK` (a member's `cb_app` context must not self-grant `role:admin`) — add to the leak
  canary. (per M0 `/review` sec S1/S6/S7/S8, adv #1) (2026-07-23)

## Contract spine (M1)

- **D26 — Ops-as-data spine, forked from gbrain.** `src/api/` holds one `operations[]` registry
  dispatched by a single path (`dispatchOp`: lookup → role-check → validate → run → shape-only log),
  exposed over REST (`/api/:op`, `/api/_ops`) and stdio MCP. Structure ported from gbrain
  (`dispatch.ts`/`scope.ts`/`tool-defs.ts`/`OperationError`) under MIT (see `NOTICE`); adapted to
  company-brain's tenant-identity ctx + **zod** params (D21). Dispatch returns a NEUTRAL result each
  transport formats. (2026-07-24)
- **D27 — Single role axis (RBAC governs verbs).** Ops carry `requiredRole` (owner ⊃ admin ⊃ member,
  default `member`) + `mutating`; dispatch gates on `ctx.role` via `roles.ts`' IMPLIES hierarchy
  (fail-closed on unknown). gbrain's read/write/admin capability scope is folded into role; **`member`
  is write-capable by default** (no read-only human role); agent-token capability scopes are deferred
  to M3 (BYO-agent). Row-level `acl && grants` is NOT exercised in M1 (M3 engine / M4 RLS). (2026-07-24)
- **D28 — The sacred M1 invariant: shapes, never values.** The request log records the param SHAPE
  (declared key names + a 1KB-bucketed size + outcome CODE + `reqId`) and never a param value or an
  error message; a handler's unexpected error goes to a SEPARATE error sink (proved by a value-in-log
  negative test). `reqId` threads the log and every response envelope. (per M1 `/review` AM1/AM6)
- **D29 — Dev-auth stub is TEMPORARY + prod-gated.** M1 resolves request identity from `x-cb-*`
  headers ONLY when `NODE_ENV != production AND DEV_AUTH=1`; the app hard-refuses to boot if that is
  on in production. Replaced at M2 by the real session→membership resolver (which reuses
  `buildContext`/`resolveGrants` unchanged). MCP's `CB_MCP_*` env identity is the same single-operator,
  non-multi-tenant caveat. (per M1 `/review` AM9) (2026-07-24)
- **D30 — MCP-in-v0 via the standard SDK.** The stdio MCP transport ships in M1 (D19) using
  `@modelcontextprotocol/sdk` (pinned exact) + `zod-to-json-schema` (zod floor bumped to `^3.25.28`).
  Cuttable to M3 if M1 slipped; it did not. (per M1 `/review` T1) (2026-07-24)
- **D31 — Next milestone is the A17 answer-quality spike**, NOT folded into M1: a single-workspace
  ingest→search→answer run over a real messy corpus + a small hand-graded eval (D15 exit criterion),
  to validate retrieval + DeepSeek answer quality before more infra. (per M1 `/review` UC1) (2026-07-24)

## M0+M1 bug-fix pass

- **D32 — Registries keyed by attacker-controlled strings must be null-prototype.** `operationsByName`
  (op names from `req.params.op`/MCP `tools/call`) and any future lookup keyed on untrusted input use
  `Object.create(null)` or an `Object.hasOwn` guard, never a plain `{}` — a plain object resolves
  inherited `Object.prototype` members (`toString`, `constructor`, `__proto__`, `hasOwnProperty`) as
  truthy, which crashed dispatch *before* its try-block and silently skipped the request-log line
  (found by a 3-reviewer `/review` sweep, confirmed live). `roles.ts`' `hasRole` carries the same guard.
  (2026-07-24)
- **D33 — Dev-auth env gate is an allowlist, not a blocklist.** `devAuthEnabled`/`assertDevAuthSafe`
  require `NODE_ENV ∈ {development, test}` — NOT `NODE_ENV !== 'production'` — so an unset or
  misspelled `NODE_ENV` (`prod`, `Production`, blank) can never leave the header-trusting dev-auth
  stub live. This was the sole barrier to cross-tenant reads in M1; it now fails closed on the
  environment axis too, and the boot guard runs at module import time (not only under
  `import.meta.main`). Also hardened this pass: an explicit Express terminal error middleware (closed
  envelope for malformed/oversized JSON, no stack leak), `statement_timeout`/
  `idle_in_transaction_session_timeout` on the `cb_app` pool, `embed()` ordering by provider `index`
  (not position), and a widened `TXN_CONTROL` migration guard. (per `/review` 2026-07-24)
