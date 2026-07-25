# DECISIONS.md

One line per irreversible or load-bearing choice. Newest context at the bottom of each
section. Full rationale + the multi-lens `/autoplan` review live in the plan doc at
`~/.claude/plans/velvety-crafting-pumpkin.md`.

## Product / strategy

- **D0 — Category:** multi-tenant SaaS "company brain" (YC RFS), India-first, Google-centric,
  invite-driven, demo-first then design-partner-driven. (2026-07-23)
- **D0.1 — CLOSED (2026-07-25): default upload scope is WORKSPACE, with a private option that is
  recorded CORRECTLY now and enforced at M4.** Precision matters here, and an earlier wording of this
  entry ("a private option that actually works") overstated it: at M2 **nothing reads the `acl`**.
  The only policies on the content plane are workspace-equality (`pages_ws`, `content_chunks_ws` in
  schema.sql), no policy anywhere references `app.grants`, and `hybridSearch` adds no acl predicate.
  So `scope:'private'` today means "this row will be private the moment M4 lands", not "other members
  cannot read it". What was fixed is that the row is now written with an `acl` matching its label —
  which is the part that is unrecoverable later. `ingest` takes `scope: 'private' | 'workspace'`
  (default `workspace`), and the row's `acl` is **derived** from it by `aclForScope()` — `private` → `['self:<author>']`,
  `workspace` → `['ws:<workspace>']`. Forced by the M1+M2 review: `scope` had been free text with no
  CHECK while `importPage` stamped a workspace-wide `acl` unconditionally, so `private` produced a
  row every member could read. That was not merely a mislabelled column — at M4 the enforced RLS
  predicate becomes `acl && current_grants()`, which reads the ACL and never the label, so every row
  written in between would have been permanently mis-scoped with the author's intent unrecoverable.
  Deriving one from the other makes a mismatched pair unrepresentable; migration `0003` adds the
  DB-side CHECK and aligns the column default. Decided while all 12 existing rows were uniform, so
  no backfill was needed — after M4 this would have been a data migration.
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

- **D10 — Roll-your-own Google OIDC** (relying-party login, hashed sessions, workspaces, invites,
  keyring resolver). **AMENDED 2026-07-25 (G7):** the original rationale — "chosen over managed auth
  for the India data-residency pitch" — was **factually false** and is withdrawn: the Supabase
  project is in `aws-1-ap-northeast-2` (**Seoul**), so every page, chunk and principal already lives
  outside India. The real grounds for the choice are **full control over the session model and no
  auth-vendor coupling**. The founder chose to stay in Seoul rather than re-provision in
  `ap-south-1` while the database was empty; if residency later proves to be a genuine buying
  objection, that move becomes a data migration rather than a ~30-minute re-provision. Highest blast radius → mandates the OperationError/auth-code taxonomy (M1), a 2-tenant
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
- **D24 — `doctor.ts` checks (PULLED FORWARD to M2-5, was M4).** Shipped as `bun run doctor`: 43
  assertions plus four checked-in snapshot fixtures (definers, table grants, **column** grants,
  policies). Pulled forward because M2's whole security posture lives in GRANTs and POLICIES, which
  no unit test can observe. Two findings from building it: `information_schema.role_table_grants`
  **cannot see column grants** (they live in `pg_attribute.attacl` → `role_column_grants`), so a
  matrix asserted from table grants alone is blind to exactly the cells that carry the boundary; and
  a real Supabase project **ships its own `SECURITY DEFINER` function in `public`**
  (`rls_auto_enable`, backing the `ensure_rls` event trigger), so "there must be zero definers in
  public" is false — the fixture snapshots it instead, which also catches any change to it.
  **Corrected 2026-07-25 (M2 post-build `/review`):** this entry previously said the four original M4
  assertions were "all now implemented". Only one was (`cb_app` is `NOBYPASSRLS`). The other three
  were added during the review, and the gap they left was serious: `doctor` checked
  `relforcerowsecurity` (the *opposite* flag) and nothing checked `relrowsecurity`, while `pg_policies`
  lists policies whether or not RLS is enabled — so `ALTER TABLE content_chunks DISABLE ROW LEVEL
  SECURITY` left all four fixtures byte-identical and every boolean green. The single largest
  tenant-isolation regression possible was the one the auditor could not see. Now asserted: `cb_app`
  and `cb_auth` are `NOBYPASSRLS`; **every `public` table has RLS ENABLED** (`_migrations` exempt —
  it is fully revoked instead); no table is RLS-enabled-with-zero-policies; `content_chunks.embedding`
  dimension === `EMBEDDING_DIM`. Count is now **46** checks (42 assertions + 4 fixtures), and the
  fixture snapshots include `PUBLIC` as a grantee, because cb_app/cb_auth hold PUBLIC's privileges in
  addition to their own and a grant to PUBLIC was previously invisible.
  (per M0 `/review` sec S2, data-mig D7/D8; corrected per M2 post-build `/review`)
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

## Identity (M2) — built 2026-07-25

- **D34 — Refresh-token rotation is CUT from M2 (G2).** The design as reviewed was
  *unimplementable*: only SHA-256 hashes are stored, so the specified grace-window behaviour
  ("return the already-rotated pair") could not be performed — the raw tokens do not exist anywhere.
  It also had no caller (no `/auth/refresh` route), i.e. it was dead code. M2 ships a single session
  token with an ABSOLUTE 7-day expiry (**G5**, halved from 14 because with rotation cut there is no
  reuse detection). "Sign out everywhere" is `principals.session_epoch`, bumped through a definer
  function and compared against a per-session `sessions.epoch` stamp. Rotation + reuse detection
  return at M5 with the real UI. `sessions.refresh_hash`/`refresh_expires_at` stay NULL.
- **D35 — The per-request tenant read is a `SECURITY DEFINER` function (G3).** `cb_internal.
  resolve_session(token_hash)` does session lookup + expiry + epoch + the D25 membership
  re-verification in ONE statement, and returns `(reason, principal_id, workspace_id, member_role)`.
  Its signature is **locked**: it takes no principal or workspace argument, because such a parameter
  would make it a membership oracle keyed on request input. `workspace_id` and `member_role` are
  selected only from the membership row, so "no membership ⇒ no workspace" is structural. This keeps
  `USING(true)` off every `/api/:op` request; `cb_auth` (**G8**, retained) is now touched only by
  login/onboarding writes. Postgres grants `EXECUTE` to PUBLIC on every new function, so the
  `REVOKE ALL … FROM PUBLIC` is load-bearing and must be re-asserted on every migrate — which is why
  these live in `migrate.ts`, not in a checksummed migration file.
- **D36 — The grant deny-matrix is the real tenant-isolation control, and it lives in `migrate.ts`.**
  `grantExisting()` re-grants `select,insert,update,delete on ALL tables` on EVERY run, so anything
  revoked inside a migration file is silently re-broadened moments later. `narrowGrants()` runs
  after it, and all three grant steps commit in ONE transaction — a transaction beginning after
  `grantExisting` committed would leave exactly the window it claims to close. Two defects this
  closes: **`WITH CHECK (false)` does not block DELETE** (Postgres governs DELETE by `USING` alone),
  so without the revoke any member could `DELETE FROM workspaces` and cascade away an entire tenant;
  and `workspaces_current` is `USING`-only, so `UPDATE workspaces SET domain=…` would let a member
  hijack another org's auto-join.
- **D37 — A workspace domain may only be claimed from the Google-signed `hd` claim of THAT login**,
  carried on `sessions.login_hd` (the ID token and the oauth cookie are both gone by the time the
  bootstrap request arrives). The email's domain is **never** a substitute: Google sets `hd` only for
  Workspace accounts, so a consumer account can own a mailbox at any custom domain and would
  otherwise permanently squat that domain's auto-join (`workspaces.domain` is UNIQUE). dev-login
  always has `login_hd = NULL` and therefore can never claim a domain.
- **D38 — Invites are consumed ONLY by presenting the token.** A pending invite is never
  auto-consumed on login: otherwise anyone who knows your email could make you a member of their
  workspace and have it become your ACTIVE workspace on first sign-in, so your first upload would
  land in their tenant. The claim is a single `UPDATE … WHERE token_hash AND status='pending' AND
  expires_at > now() AND email_normalized = …`, which is also the only enforcement of
  `INVITE_TTL_DAYS`. Wrong token, expired, already-accepted and addressed-to-someone-else all return
  the SAME generic `404 invite_invalid` — distinguishing them would confirm an invite exists.
- **D39 — D25 holds on every surface, not just HTTP.** `bun run call`, the stdio MCP bridge and the
  A17 scripts all call `assertMembership()`, which verifies the (principal, workspace) pair and
  returns the **authoritative** role. `CB_CLI_ROLE`/`CB_MCP_ROLE` are deleted — an env-supplied role
  is ignored by construction. Consequence: those entrypoints now touch the database at startup.
- **D40 — `POST /auth/dev-login` has five gates and must not EXIST unless all pass.** It mints a real
  session for any email with no verification. Gates: `DEV_AUTH=1`, `DEV_LOGIN=1`, `NODE_ENV` set
  **explicitly**, `NODE_ENV` ∈ {development,test}, and `APP_BASE_URL` set **explicitly** and
  loopback. The two "explicitly" gates exist because both values have defaults that would otherwise
  pass unnoticed on an unconfigured box. Gate 2 off ⇒ the route 404s (never 401 — that would confirm
  it exists); any other gate failing while `DEV_LOGIN=1` ⇒ **the app refuses to boot**.

## M2 post-build review (2026-07-25)

A `/review` of the built M2 — six specialist passes plus an adversarial pass — found one dominant
failure mode, and it was not "the code is wrong". It was **security controls that were written,
documented, and then never wired up**, with green tests and a green `doctor` throughout. The
decisions below encode the fixes so the pattern does not repeat.

- **D41 — A guard a caller can skip is not a guard: hand out the pool only through the assertion.**
  `assertAuthPoolRole()` was written, exported, described in `client.ts` as protecting against "the
  likeliest catastrophic M2 misconfiguration", documented in `docs/auth-setup.md` with the exact
  error string an operator should expect — and **called by nothing**. Eight `cb_auth` call sites had
  each independently forgotten it, and no test could notice, because the guard exists to catch a
  misconfiguration the test environment never has. Consequence had it shipped: pasting
  `DATABASE_ADMIN_URL` into `DATABASE_AUTH_URL` runs every login and onboarding query as the
  **RLS-bypassing owner**, silently. Fix: `authLane()` in `src/db/client.ts` is now the only way to
  obtain the cb_auth pool, and it awaits the (memoized) assertion first. Prefer this shape — a
  guarded accessor — over a guard the caller must remember.
- **D42 — CSRF is scoped by request PROPERTY, and mounted once, app-wide.** `checkCsrf` had exactly
  one call site, `app.use('/auth', …)`, while its own header said the rule "applies to any non-GET
  request that authenticated via cookie" and named `/api/:op` — the cookie-authenticated surface
  carrying every mutating operation — as the motivating case. `/api/:op` was unchecked. The test that
  should have caught it asserted `expect(res.status).toBeGreaterThan(0)`, which no HTTP response can
  fail. `csrfGuard` is now mounted in `index.ts` ahead of both routers. Honest severity: SameSite=Lax
  plus JSON-only body parsing blocked the classic exploit; the real gap was `Sec-Fetch-Site:
  same-site` (a sibling subdomain or another port), which Lax *does* send the cookie for.
- **D43 — `CB_REQUIRE_LIVE_TESTS` is enforced by `liveOrFail()`, and a meta-test enforces that.** The
  flag was declared in config and documented in `.env.example` as the switch that makes CI fail
  rather than skip; **nothing read it**. Every live suite skipped green on a machine with no
  database, including the entire cross-tenant canary. `test/helpers/live.ts` now throws when the flag
  is set and the environment is not configured, and `test/live-gate.test.ts` scans the suite files so
  a suite added later cannot quietly opt out. Fixing six files was not the fix; enforcing the property
  was.
- **D44 — Deployment-shape gates are boot failures, not warnings.** A `console.warn` that fires only
  under `import.meta.main` is not a control, and the configuration it warned about was the DEFAULT.
  `src/boot.ts` now refuses to start when `APP_BASE_URL` is non-loopback and `TRUST_PROXY` is unset
  (otherwise `req.ip` is the proxy's address and the `/auth` limiter collapses to ONE bucket for the
  whole fleet — 31 anonymous requests take sign-in offline for every user), when a non-loopback base
  URL is plain http (the cookie loses both `Secure` and `__Host-`, letting a sibling subdomain set a
  `cb_session` for the parent domain), and, outside dev, when `SESSION_SECRET`/`DATABASE_AUTH_URL`/
  `GOOGLE_CLIENT_*` are missing — those used to let the process boot green and fail the user *after*
  Google had already authenticated them.
- **D45 — A presented-and-rejected session must never fall through to the dev-auth stub.** The
  resolver returns `null` for `expired`, and `server.ts` did `?? resolveDevContext(req)` — so an
  expired cookie plus forged `x-cb-*` headers authenticated, making session expiry decorative in
  every environment with `DEV_AUTH=1`. The stub is now reachable only when NO session was presented
  (`hasSessionCookie(req)`). Found by writing the test, not by reading the code.
- **D46 — Membership revocation must be durable: `workspace_domain_blocks` (migration 0002).**
  Memberships are rows that exist or do not, with no "was removed" state, so removing someone from a
  domain-claimed workspace silently undid itself on their next sign-in — domain auto-join put them
  straight back as `member`, also undoing the composite-FK `SET NULL`. The tombstone outlives the
  membership row, which is the entire point. Read-only for both `cb_app` and `cb_auth`: a login lane
  that could clear its own block is not a block. M2 ships no removal endpoint (cb_app holds no
  DELETE on `workspace_members`), so removal remains a deliberate admin action — now with a supported
  shape. The admin UI that writes both rows in one transaction is M5.
- **D47 — The id_token signature is NOT what establishes trust; TLS to the token endpoint is.**
  Verified against `oauth4webapi`'s source, not assumed: it validates the ID token signature only via
  an explicitly-called `validateApplicationLevelSignature()`, and the authorization-code path does
  not call it. OIDC Core §3.1.3.7 permits exactly this — the token arrives over a direct,
  TLS-authenticated back-channel POST. So the trust anchor is TLS to `accounts.google.com` plus the
  client secret and PKCE verifier; claims (iss/aud/exp/nonce) *are* checked. `google.ts` said
  "signature against Google's JWKS", which was false. Practical consequence, now documented: anything
  replacing `fetch` (the test harness does, via `customFetch`) bypasses the anchor entirely.
  `test/google.test.ts` pins the real behaviour so a library upgrade that starts enforcing signatures
  is noticed rather than assumed.
- **D48 — Per-connection `statement_timeout` does not survive the transaction pooler; use `SET
  LOCAL`.** Measured, not inferred: with `DB_STATEMENT_TIMEOUT=15000` configured as a startup-packet
  parameter, `current_setting('statement_timeout')` inside a scoped transaction returned Supabase's
  default `2min`, and `idle_in_transaction_session_timeout` returned `0`. In transaction-pooling mode
  the client socket is not 1:1 with a backend, so those parameters never reached the session the
  query ran on — the documented "a runaway statement can't pin a pooled connection and hang the
  fleet" protection did not exist. Both are now set via `set_config(…, true)` in the same single
  round trip as the three tenancy GUCs in `withScopedTx`.
- **D49 — Destructive confirmations must name something that actually distinguishes the target.**
  `migrate:reset` required `CB_CONFIRM_RESET` to equal `current_database()` — which is literally
  `postgres` for every Supabase project, so the operator typed the same word for a scratch project
  and for the one holding the corpus. With `NODE_ENV` defaulting to `development`, three
  "independent" confirmations reduced to one: `--yes-destroy`. It now confirms on the Supabase
  **project ref** parsed from the admin URL, prints **real** `count(*)` values (not `n_live_tup`,
  an estimate that reads 0 for a never-analyzed table), pauses, and holds the migrate advisory lock
  across the drop.
- **D50 — `create_invite` ships as an op (G6 honoured), and its role ceiling has a test.** It had
  been written with a comment claiming "it has its own test for that reason", registered as no
  operation, reachable from no route, and referenced by no test — so the app-layer guard stopping an
  admin from minting an `owner` invite had never once executed, on a table where `cb_app` holds
  table-level INSERT and the database will happily store `role='owner'`. Also fixed: `acceptUrl` was
  a GET link to a POST-only route (the one documented redemption path 404'd) with the token in a
  query string; it is now a fragment on a landing path, and the accept route reads the token from the
  body only. `acceptByToken` now returns the role the DATABASE holds rather than the invite's — with
  `ON CONFLICT DO NOTHING`, an existing member keeps their role, so the old return told a member who
  accepted an owner invite that they were an owner.
- **D51 — Deferred deliberately, recorded so it is a decision and not an omission.** (a) The `/auth/*`
  success envelope is inconsistent with `/api/:op` (four routes wrap in `data`, four splat; snake_case
  vs camelCase) — changing it now churns docs and tests for no user benefit, and M5 brings the UI that
  actually consumes it. (b) Nothing reaps expired `sessions` or `invites` rows; harmless at
  design-partner scale, and after `narrowGrants` nobody holds DELETE on `sessions`, so the reaper
  needs a definer or the admin connection (M5). (c) The A17 performance items — no GIN index on
  `to_tsvector('english', content)`, `hnsw.iterative_scan` never set despite `schema.sql:262`
  requiring it, and chunk inserts one round trip at a time — are pre-existing and get their own
  commit.

## M1+M2 review (2026-07-25)

A second `/review`, this time over **M1 + A17 + M2 together** rather than M2 alone. The framing that
produced the findings: M1's dispatch spine and A17's answer pipeline were written when identity was a
dev-only header stub that could not reach production. **M2 made identity real — genuine sessions,
genuine multi-tenant traffic, a genuine threat model — and several M1/A17 designs that were honest
under the old assumption became wrong under the new one.** Three of the six P0s were gaps in the M2
fixes made earlier the same day, which is recorded here rather than buried.

- **D52 — A label that does not drive the enforced predicate is not a control.** Superseded in
  substance by the D0.1 amendment above; kept as a pointer because the *shape* recurs. `pages.scope`
  was advertised through `/api/_ops` as an access-control knob while `acl` — the column RLS actually
  reads at M4 — was hardcoded. The general rule: when a user-facing label and an enforced column can
  disagree, derive one from the other in exactly one place (`aclForScope()`), and add the CHECK so
  a second writer cannot reintroduce the disagreement.
- **D53 — `/api/_ops` is deliberately unauthenticated.** It publishes operation names and
  JSON-Schemas — the API's own documentation — touches no workspace, principal or tenant pool, and
  excludes `hidden` ops. The README quickstart curls it before a session exists and an agent needs it
  to discover what to call, so gating it would break both for no confidentiality gain: anyone who can
  read the repo has the same list. It is not unprotected — `preAuthGuard` sheds floods at 300/min/IP
  — and it now carries `reqId` like every other route, so it is no longer the one response shape a
  client has to special-case. Asserted in `test/api.test.ts` so the decision cannot drift silently.
- **D54 — Throttle before the round trip you are protecting, not after.** `apiLimiter` (added hours
  earlier) is keyed on `ctx.principal`, which is only known *after* `resolveSessionContext` has spent
  a database round trip on the `cb_app` pool — so the limiter protecting that pool could not fire
  until the pool had already been used. `looksLikeToken` rejects malformed cookies from memory, but
  any random 43-char base64url string passes it, so a junk-cookie flood walked straight through: at
  Seoul latency with a 10-connection pool, roughly 80 unauthenticated req/s to saturation. Fix:
  `preAuthGuard` (IP-keyed, 300/min, app-wide, `/health` exempt) sheds first; `apiLimiter` remains
  the per-principal budget behind it. Cheap throttle first, expensive one second.
- **D55 — Escaping cannot defend a frame built from plain-English delimiters.** `prompt.ts`
  interpolated page content and the caller-controlled slug into a pseudo-XML `<chunk>` block. The
  first fix escaped angle brackets — and an adversarial pass broke it immediately, because
  `Question: ` and `Respond with the JSON object…` are delimiters with no escapable character in
  them. The frame is now keyed by a **per-request random nonce** (`--BEGIN-EVIDENCE-<nonce>--`), the
  nonce is stripped from all interpolated text, and the slug is sanitized to an allow-listed charset.
  A poisoned page cannot name a delimiter it cannot predict. Citations are separately clamped to
  `1..sources.length` and out-of-range markers scrubbed, and `AnswerResult` now returns resolved
  `cited` hits so no caller has to know the citation base.
- **D56 — Revocation must be enforced on every surface, and the agent surface was the permissive
  one.** `mcp.ts` resolved identity once at process start and reused that frozen context for the life
  of the process. Under M1 that was honest — the role came from a static env var. M2 replaced it with
  `assertMembership()`, a real database read, which made it *look* authoritative while it was cached
  indefinitely, so removing or demoting a principal had no effect on a running bridge (MCP hosts keep
  stdio processes alive for days) while the HTTP path re-read membership on every request. Context is
  now rebuilt per call with a 30s TTL.
- **D57 — Unbounded input turns a 400 into a 500.** Every op param now carries a bound (`slug` regex
  + 200, `title` 300, `body` 200k, `tags` 50×64, `question` 2000), a duplicate slug maps 23505 → a
  typed 409 instead of `internal_error` *after* the embeddings have been paid for, and the registry
  is `.strict()` in one place so the published `additionalProperties: false` is true at runtime —
  previously an agent sending `tag` instead of `tags` got a 200 with the metadata silently stripped.
- **D58 — `hnsw.iterative_scan` is a tenancy control, not a latency knob.** Filed under D51c as
  deferred performance; that was wrong. Without it the HNSW scan returns globally-nearest candidates
  and RLS post-filters them, so **one large tenant silently degrades every other tenant's
  retrieval** — a cross-tenant effect on the path whose entire job is answer quality. Now set in the
  same `withScopedTx` round trip as the tenancy GUCs.
- **D59 — Pin what you own; assert (don't pin) what you don't.** `doctor`'s definer fixture hashed
  the body of Supabase's own `public.rls_auto_enable()`. Vendor maintenance legitimately changes it,
  and a check that goes red for a reason the operator cannot act on teaches them to reach for
  `--update` reflexively — which is exactly how a real regression gets rubber-stamped. Its body is no
  longer pinned; its owner, pinned `search_path` and ACL still are, and a NEW definer appearing in
  `public` still fails the diff.
- **D60 — Third-party text must be flattened before it enters a log stream.** A provider error body
  (up to 500 bytes) rode verbatim into a `RouterError` message and from there into a stream of JSON
  log lines, so a body containing a newline plus `{"level":"info","kind":"auth",…}` could append a
  forged record. Same frame-injection shape as D55, one layer down. Control characters and newlines
  are now flattened; the readable text survives, because `insufficient credits` and `context length
  exceeded` are what make a 500 diagnosable.
- **D61 — Constraints the code relies on belong in the database (migration 0004).** `(page_id, ord)`
  is now UNIQUE — `ORDER BY ord` is how a page is reassembled, and duplicates make that
  nondeterministic. The three *attribution* FKs to `principals` (`workspaces.created_by`,
  `invites.invited_by`, `invites.accepted_by`) are now `ON DELETE SET NULL`: they carried the default
  NO ACTION, so deleting a principal failed unless you first deleted every workspace they created —
  making account deletion, and any erasure request before M5, structurally impossible without
  destroying other tenants' data. `workspace_domain_blocks.principal_id` gets a covering index —
  **and so, in migration `0005`, do the four the review caught 0004 missing or creating**:
  `acl_grants.principal_id` (an ON DELETE CASCADE FK whose only index is `workspace_id`-leading, so
  it never covered it) plus the three attribution columns 0004 itself converted to SET NULL, since
  SET NULL needs the same referencing-side lookup CASCADE does. 0004's own header calls
  `workspace_domain_blocks` "the one FK in the schema without a covering index"; that was false when
  written, and 0004 made it more false. Deliberately NOT constrained: `pages.kind` stays open text (the
  five-value list is a convention so a new OKF type needs no migration) and `content_chunks.embedding`
  stays nullable (deferred/background embedding stays possible) — the read path now filters
  `embedding IS NOT NULL` explicitly instead of relying on NULLs sorting last, which is a property of
  the sort direction rather than a guarantee.
- **D62 — A fixture can make a property unprovable.** Two tests asserted a property in a comment and
  something weaker in code. The chunker's losslessness test used `'x'.repeat(20000)`, where every
  slice is indistinguishable from every other — so a chunker dropping 5,000 characters passed. It now
  uses position-encoded content and asserts coverage has no gap; verified by deliberately dropping one
  window and watching it go red. `noUnusedLocals`/`noUnusedParameters` are now on, which is what
  surfaced that `normalize.test.ts` *imported* `isPublicDomain` and never called it — the
  domain-auto-join gate (D11), whose failure mode is auto-joining every Gmail user into one
  workspace, had zero coverage behind an import that looked like coverage.
- **D63 — `ALTER ROLE … PASSWORD` is not idempotent, and it was churning the pooler's credential
  cache.** Found mid-verification, when all three lanes — app, auth AND admin — began refusing
  connections with `08006 econnrefused` and then `XX000 (ECIRCUITBREAKER) too many authentication
  failures, new connections are temporarily blocked`. Nothing in the diff touched connection handling.

  **Attribution, stated carefully, because the first version of this entry over-claimed.** Two
  distinct things were happening and only one of them is ours:
    * *Ours, and well-evidenced:* the scattered `28P01 Authentication credentials are invalid. Please
      reconnect with fresh credentials to restore pool functionality` errors, and the
      `ECIRCUITBREAKER` message that explicitly names authentication failures. Those are the pooler's
      cached SCRAM credentials going stale, which is exactly what the defect below produces.
    * *Not established as ours:* the sustained outage that followed. A TCP probe showed both pooler
      ports (5432, 6543) **open and accepting connections**, and `{:error, :econnrefused}` is
      Supavisor's own Elixir error failing to reach the Postgres instance BEHIND it. A healthy pooler
      that cannot reach its backend is a paused/stopped/restarting project, not a tripped breaker.
      The honest conclusion: the defect below is real and was causing real auth failures; whether it
      contributed to the instance going down is unproven, and the entry should not claim it did.

  The defect: `ensureBootstrap`/`ensureAuthRole` issued
  `alter role cb_app login password …` **unconditionally on every run**, and a SCRAM-SHA-256 verifier
  is salted with fresh randomness — so re-setting the *same* password still writes a *different*
  verifier. Supabase's pooler (Supavisor) caches tenant SCRAM credentials, so each migrate run
  invalidated that cache and produced a burst of `28P01` "reconnect with fresh credentials" failures;
  enough of those trip a circuit breaker that then blocks new connections for the entire project.
  **The `28P01`s were misread as transient network noise four separate times before the breaker made
  the pattern legible** — they were the leading indicator, not noise. Fix: `scramMatches()` verifies the configured password against the stored
  verifier per RFC 5802 (PBKDF2 → HMAC "Client Key" → SHA256 → compare StoredKey) and the `ALTER` is
  skipped when it already matches. A verifier that cannot be read or parsed returns `null`, not
  `false`, so "cannot tell" still sets the password and only "definitely correct" skips it.
  `test/scram.test.ts` covers it with no database — fitting, for a function that exists because the
  database went away. The general rule: **"idempotent" means the observable state is unchanged, not
  that the statement is safe to repeat.** A statement that rewrites salted material is a write every
  time, whatever it looks like.
- **D64 — Reviewed my own fixes before committing them, and eight held.** The M1+M2 review's most
  uncomfortable finding was that three of its six P0s were gaps in fixes made hours earlier in the
  same session. So the fix diff for that review was itself put through an adversarial pass — six
  lenses, then independent verifiers prompted to REFUTE each finding — before commit. Eight
  confirmed, two refuted. The confirmed set is instructive because it is the same failure mode
  again, in fresh code:
  - **`preAuthGuard` exempted `/health/db` from the flood shed** on the stated grounds that "neither
    exempt path touches the tenant pool". `/health/db` calls `appSql()` — it is the cb_app pool, the
    exact 10 connections the guard's own docstring says saturate at ~80 req/s. The new guard shipped
    with one unauthenticated, DB-touching, unthrottled route: a cheaper junk-cookie flood needing no
    cookie. Only `/health` (pure in-memory) is exempt now.
  - **A test I added would have failed a CORRECT implementation.** `hybrid.test.ts` asserted every hit
    came from an allow-list of two slugs, while the same `beforeAll` ingests *three* pages into that
    workspace. The vector arm has no relevance cutoff, so the third was always going to be returned —
    that is the premise of the test's own title.
  - **The citation scrub guarded only the structured path.** `parseAnswerJson`'s degrade path returned
    the raw completion unscrubbed — and the degrade path is the one an injected prompt is *most* likely
    to reach, because "ignore the format" and "ignore the question" are the same instruction.
  - **The prompt-injection test for the nonce defense was vacuous.** It injected a *different* message's
    nonce; since each message mints a fresh one, it could never collide, so the test passed with the
    masking deleted. Verified by deleting it. `stripFrameHazards` is now exported and tested directly
    — the unreachable-through-the-public-API branch is exactly the one that needs a direct test.
  - **Migration 0004 asserted the FK-index sweep was complete and made it less complete** (see D61).
  - Plus four prose claims that were simply false: `client.ts` still said "FIVE settings" beside six,
    `envelope.ts` claimed "exactly one writer" with six copies surviving in the file it named,
    `doctor.ts` still promised it catches "a changed body" for a definer it had just stopped hashing,
    and 0003's persisted `COMMENT ON principals` said `google_sub` is written only by the definer
    while `workspaces.ts` INSERTs it directly on first login.

  The rule this pass earns: **a fix is not more trustworthy than the code it replaced just because it
  is newer.** Fresh code written under time pressure to close a review finding is written in exactly
  the state — confident, unreviewed, and touching security-relevant paths — that produced the findings
  in the first place. Review the fix diff, not just the original.
- **D65 — Measure first: three of the four planned search optimizations were worth 14ms combined.**
  The A17 latency work was planned as `Promise.all` the two search arms, drop the `pages` JOIN from
  the vector arm, and stop over-fetching `content` for 40 candidates to keep 8. Baselined against
  Supabase ap-northeast-2 (one pooler round trip ≈ 110ms), those measured **0ms, 1ms and 13ms**.
  `Promise.all` — the headline item — is worth nothing because a transaction holds ONE connection and
  postgres.js runs its statements in order on it, so concurrency at the JS level buys no parallelism
  at the wire level. A fourth idea of my own, shrinking the 29KB query-vector literal, was also
  rejected on measurement: `toPrecision(7)` is 39% smaller and saved 11ms, because the cost is the
  server-side `::vector` PARSE of 1536 elements rather than the bytes — and it is not even lossless
  (`eq:false` after the float4 cast; float4 round-trip needs 9 significant digits).

  What did work was the thing the plan did not name: **issue fewer statements**. `hybridSearch` became
  one statement (both arms plus RRF as CTEs), 930→691ms; `importPage` became one multi-row INSERT
  instead of one round trip per chunk, 5464→1313ms for 20 chunks — a 40-chunk document had been
  spending ~4.4 seconds holding a pooled connection doing nothing but waiting. End to end,
  `ask` went 1035→704ms (−32%), 9.6→6.4 round trips.

  Two things this makes a rule. **A performance plan written from reading code is a list of
  hypotheses, not a list of tasks** — the baseline is what turns it into work worth doing, and it is
  cheap next to implementing three changes that do nothing. And **moving tested logic into SQL needs
  an equivalence test, not confidence**: RRF's move into the query had two traps (`rrfFuse` ranks from
  zero while `row_number()` starts at one; RRF ties are common and previously broke on Map insertion
  order, i.e. on whichever arm the database returned first). `rrfFuse` stays the specification, now
  with a deterministic id tie-break, and a live test asserts the SQL agrees with it on real data.
