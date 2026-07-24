# M0 Review — Remediation Plan

## Context

`/review` ran six passes over the M0 foundation (testing, maintainability, security, performance,
data-migration, adversarial). Five completed; the adversarial pass was interrupted and re-run
read-only afterward, so coverage is now complete. This plan triages ~50 raw findings into what to
change now vs. defer. M0 is the baseline schema + role model — the "hardest to retrofit" layer — so
the bar for "fix now" is: cheap, and expensive-or-dangerous to change once real tenant data or M1
code lands. Nothing here is a working bug in what shipped (migrate + RLS smoke passed live); these
are hardening and correctness-of-foundation changes.

**Two of the biggest perf findings are already fixed** by your `client.ts` edit (single-round-trip
GUCs + `max:1` admin pool). Credited below, not re-done.

**Delivery method (important):** `schema.sql` is an applied-once baseline and is already applied to
the live (empty) Supabase DB. Since the DB holds no real data yet, the clean path is to **edit
`schema.sql` and reset+re-apply** (drop the public tables + clear `_migrations`, then `bun run
migrate`), keeping one canonical baseline rather than a baseline plus an immediate correction
migration. This is destructive only of an empty schema. Alternative if you prefer never to touch an
applied file: ship all schema changes as `src/db/migrations/0002_m0_hardening.sql`. **Recommend
reset+re-apply.**

---

## A. Schema hardening (`src/db/schema.sql`) — requires reset+re-apply

1. **Membership-integrity FK on sessions** (sec S1, adv #1/#8/#10 — the top finding). Add
   `FK sessions(active_workspace_id, principal_id) REFERENCES workspace_members(workspace_id,
   principal_id) ON DELETE SET NULL`. This makes the DB refuse a session whose active workspace
   isn't a real membership — closing the "workspaceId taken on trust" gap at the layer that can't be
   forgotten. (App-side resolver enforcement is M2; see F.)
2. **Denormalized-tenancy consistency FKs** (sec S9, adv #6). Add `UNIQUE(id, workspace_id)` on
   `pages` and `teams`, then composite FKs `content_chunks(page_id, workspace_id) REFERENCES
   pages(id, workspace_id)` and `team_memberships(team_id, workspace_id) REFERENCES teams(id,
   workspace_id)`. Makes a mis-stamped `workspace_id` on a chunk impossible instead of a silent
   cross-tenant leak on the hot path.
3. **RLS init-plan pattern** (perf P3). Rewrite all 10 policies to wrap the GUC read once:
   `USING (workspace_id = (SELECT current_setting('app.workspace', true)::uuid))`. Evaluates per
   query, not per row — matters on the M3 HNSW candidate scan and the M4 `acl && grants` refinement.
4. **Index fixes** (perf P2/P5/P6/P7/P8):
   - add `idx_workspace_members_principal (principal_id)`, `idx_team_memberships_principal
     (principal_id, workspace_id)` (Postgres doesn't auto-index FK columns; needed for M2 login + cascades)
   - add `idx_invites_email (email_normalized) WHERE status='pending'` (login-time invite match is email-only, pre-workspace)
   - change `idx_chunks_page` → `(page_id, ord)`; drop redundant `idx_pages_ws` (covered by `UNIQUE(workspace_id, slug)`)

## B. Migration runner hardening (`src/db/migrate.ts`)

5. **Immutable-baseline safety** (data-mig D2). Add a `checksum` (sha256) column to `_migrations`;
   fail loudly if an already-applied file's content changed. Create `src/db/migrations/` with a
   `README` note that applied files are frozen and changes go to new `NNNN_*.sql`.
6. **Non-transactional escape hatch** (data-mig D1). Support a `-- migrate:no-transaction` pragma
   (run the file outside `sql.begin`, e.g. future `CREATE INDEX CONCURRENTLY`); reject files
   containing bare `BEGIN`/`COMMIT`.
7. **Ordering + import safety** (testing T8). Guard `run()` with `if (import.meta.main)`; extract and
   export `orderMigrations(names)` with a numeric-aware sort (so `10_` sorts after `2_`) or enforce
   zero-padding.
8. **Bootstrap hygiene** (sec S10, data-mig D4/D7, adv #8): clear the password GUC after role setup
   (`set_config('cb.app_password','',false)`); **skip granting cb_app on `_migrations`**; exit
   non-zero (not 0) if it applies schema but can't produce a usable `cb_app`.
9. Optional: `pg_advisory_lock` at start so concurrent `migrate` runs serialize instead of erroring
   (data-mig D11).

## C. Application code fixes

10. **`src/core/context.ts`** — validate `principal`/`workspaceId` as UUIDs in `buildContext` (adv #2:
    a non-UUID GUC makes `::uuid` abort the whole tx); tighten grant-tag validation from "no commas"
    to a strict allowlist `^(self|ws|team|role):[A-Za-z0-9_-]+$` rejecting empty/whitespace (sec S11);
    export a shared `serializeGrants()` + `GRANT_SEPARATOR` so the app-side join and the M4 SQL split
    share one definition (maint M6).
11. **`src/ai/router.ts`** — add `AbortSignal.timeout(...)` to both `fetch`es and bound the error-body
    read (perf P11, adv #4); make `currentScope()` **fail closed** when unbound (throw, or default
    `zdr:true`) so a forgotten `withRouterScope` can't silently disable ZDR (sec S5, maint M4);
    assert `embed()` output length === `config.EMBEDDING_DIM` (maint M1 — makes the dim constant
    load-bearing); drop the unused `RouterScope.workspaceId` or start using it.
12. **`src/index.ts`** — `/health/db` returns generic `{status:'error'}` (log detail server-side) to
    stop leaking DB host/role/SQL to anonymous callers (sec S3, adv #7); export `app` and guard
    `app.listen` with `if (import.meta.main)` for testability (testing T5).
13. **`src/db/client.ts`** — guard that `DATABASE_URL` is non-empty before building the pool (mirror
    the admin-URL guard; adv #5 — empty URL silently hits localhost); export `sslOption`; add
    config-driven pool options (`max`, `idle_timeout`, `connect_timeout`) instead of library
    defaults (perf P10); assert `ctx.grants.length > 0` in `withScopedTx` as a last-hop backstop
    (testing T7). *(Single-round-trip GUC + admin `max:1` already done — keep.)*
14. **`src/config.ts`** — extract a pure `parseConfig(env)` (testing T6); make `DB_SSL` default to
    `verify-full` behavior in production and warn at boot if prod + not verify-full (sec S4, adv #9);
    derive the dev `OIDC_REDIRECT_URI` default from `PORT` (maint M8).

## D. Tests (new — none exist today; `bun test`)

15. `test/context.test.ts` — `buildContext` fail-closed (all error codes + happy path), the
    comma/format grant-smuggle rejection, `visibleBy` deny/allow + empty-acl/empty-grants boundaries,
    `resolveGrants` shape (testing T1/T2).
16. `test/router.test.ts` — `parseModelId` (no-colon default, colon-beats-slash, empty), and the
    D12.1 contract that `chat()` throws when `CHAT_MODEL` is unset (env-guarded) (testing T4).
17. `test/rls-smoke.test.ts` — commit the manual 3-case RLS check as an `env-gated` test (skips
    cleanly without DB creds): seed 2 workspaces via `adminSql()`, assert through the `cb_app` pool
    that no-GUC=0 rows, correct-ws=own row only, wrong-ws=0 rows (testing T3). Distinct from, and a
    down payment on, the M3 leak canary.

## E. Docs / decisions

18. Reword **DECISIONS D1** and the **README** invariant: workspace_id is on every *content/tenancy*
    table; the *identity plane* (`principals`, `sessions`) is global with self-scoped RLS — the
    current "every content + identity row carries workspace_id" is contradicted by the schema
    (maint M2).
19. Reconcile the **admin connection** docs to reality: we use the **session pooler** for
    admin/migrations (not the direct IPv6-only host). Update **DECISIONS D22**, `.env.example`, and
    the `config.ts`/`client.ts` comments (maint M9).
20. Fix `schema.sql` header comment "M0 enforces per-row acl in app-layer engine queries" → M0 ships
    the resolver only; acl-in-queries is M3, RLS refinement M4 (maint M5).
21. Add a **"Migration conventions"** section (DECISIONS/README): forward-only + Supabase PITR as the
    rollback path (and verify PITR/backups are enabled), migrate-before-deploy ordering,
    expand→backfill→contract for NOT NULL, zero-padded filenames, `CONCURRENTLY` for post-baseline
    indexes, immutable applied baseline (data-mig D10).
22. Commit a snapshot of the plan to `docs/` and repoint README/DECISIONS at it (the current
    `~/.claude/plans/...` link is machine-local, unresolvable in any clone) (maint M7). Fix the
    migrate "create it manually; see README" message to match reality (maint M3).
23. Record required **`doctor.ts` checks for M4** in DECISIONS (built at M4, not now): every
    cb_app-privileged table has RLS enabled; no table is RLS-enabled-with-zero-policies (catches the
    Supabase auto-RLS default-deny trap); `content_chunks.embedding` dimension === `EMBEDDING_DIM`;
    `cb_app` remains `NOBYPASSRLS` (sec S2, data-mig D7/D8).

## F. Deferred — documented now, built at the milestone that introduces the risk

- **M2:** membership-verified resolver — `buildContext`/its producer must derive `workspaceId` only
  from a `workspace_members` lookup, never raw request input (the FK in A.1 is the DB backstop; the
  app logic is M2) (adv #1, sec S1). A dedicated least-privilege **`cb_auth`** role for the
  auth-plane (so pre-auth lookups don't run on the RLS-bypassing owner) (sec S6, adv #8).
  Column-level `GRANT UPDATE(name, updated_at)` on `principals` so profile writes can't rewrite
  `google_sub`/`email` (identity-binding hijack) (sec S7).
- **M2/M4/M5:** writes to `acl_grants` / `workspace_members` / `teams` must route through the
  admin/auth connection or gain admin-only WITH CHECK — today a member's `cb_app` context could
  self-grant `role:admin` once those tables are written (sec S8). Add these to the leak-canary set.
- **M3:** HNSW build strategy for the first bulk ingest (drop/load/rebuild vs. always-on) and
  `m`/`ef_construction` tuning — keep the M0 always-on index, document the tradeoff (perf P4,
  data-mig D9).

## G. Already fixed / won't change

- Single-round-trip GUCs + admin `max:1` — **done in your `client.ts` edit** (perf P1/P9, data-mig D5).
- `format(%L)` role bootstrap — confirmed injection-safe by two reviewers; no change beyond clearing
  the GUC (B.8) (data-mig D4).
- `withScopedTx` `as Promise<T>` cast (adv #11, conf 4/10) — cosmetic typing; leave for now.

## Verification

- `bun run typecheck` clean.
- `bun test` green: `context.test.ts` + `router.test.ts` run with no DB; `rls-smoke.test.ts` runs
  against live Supabase and re-proves the 3-case isolation (no-GUC=0, own-ws=1, wrong-ws=0).
- Reset + `bun run migrate` re-applies the hardened baseline; re-run the live posture check
  (`cb_app` NOBYPASSRLS, RLS on all tables, 10 policies, pgvector present) and confirm the new FKs
  reject a cross-tenant chunk insert and a non-member session `active_workspace_id`.
- `GET /health` = ok; `GET /health/db` = ok and now returns no internal error detail on failure.

## Not in scope

M1 (dispatch spine, `/api/:op`, MCP), auth, ingest, search — their absence is not a finding. This
plan only hardens the M0 foundation and adds its missing tests.
