# CONTEXT.md — session bootstrap

Produced by a review that read both branches end to end, all 94 `DECISIONS.md` entries, and
adversarially verified every claim below against the code (2026-07-29, ~2.2M tokens across two
passes). Read this once instead of re-deriving it.

**How this relates to the other docs:** `DECISIONS.md` is the reasoning and survives refactors —
trust it, with the corrections in §7. `HANDOVER.md` (M3 branch only) narrates the session that built
M3 — trust it, with the corrections in §8. `README.md` is stale in ways §5.4 lists. This file is
where the repo actually *is*, and where those three get out of sync with the code or each other.

Written against `master` = `fe9b4eb` and `claude/context-review-5957e4` = `e9e9b89`. **If either SHA
has moved, re-derive §1 and §6 before trusting them; the rest ages more slowly.**

---

## 0. Start here

**Confirm which tree you're in** — `git branch --show-current` — before acting on anything below.
This doc was written from `master`; M3's features (`src/ingest/extract/`, ops 8–12, migrations
`0007`–`0011`) exist only on `claude/context-review-5957e4`. Neither branch is canonical until they
are reconciled — that reconciliation is the top of the punch list, not a detail.

**Working first-run** (Supabase already provisioned per `README.md` "Local dev"):
```bash
ls -l .env                            # if it's a symlink, do NOT `cp` onto it — see §4
cp .env.example .env                  # only if it's not a symlink
bun install
bun run migrate && bun run migrate    # TWICE — doctor.ts:9's idempotency check needs a second run
bun run doctor                        # must be green: 62 checks on M3, 46 on master
bun run dev                           # GET /health -> {"status":"ok"}
```
Dev sign-in needs `DEV_AUTH=1 DEV_LOGIN=1` uncommented in `.env` (both ship commented out).
`SESSION_SECRET` can stay **empty** for this path — it's required only by real Google OAuth
(`GET /auth/google`'s state cookie), not by dev-login. Three calls, in order (fresh DB lands you
workspace-less by design):
```bash
curl -s -c c.txt -XPOST localhost:3000/auth/dev-login -H 'content-type: application/json' -d '{"email":"you@example.com"}'
curl -s -b c.txt -c c.txt -XPOST localhost:3000/auth/workspaces -H 'content-type: application/json' -d '{"name":"My Workspace"}'
curl -s -b c.txt -XPOST localhost:3000/api/whoami -H 'content-type: application/json' -d '{}'
```

**Offline verify loop** (no DB): `bun run typecheck && bun run test` — live suites skip without a DB
unless `CB_REQUIRE_LIVE_TESTS=1` (needs Supabase + provider keys; a skip under that flag is a
failure, by design).

**If you do only three things beyond that:**
1. Reconcile the branches — start with `isDevEnv` (§6.1) and the D66/D67 ID collision in
   `DECISIONS.md` (§1) before that file drifts further apart.
2. Vendor `docs/enabling-team-scope.md` into the repo (§5.1) — the spec for the #1 open item
   currently survives only on one Desktop.
3. Move the rate limiter in front of `dispatchOp`, not in front of the Express route (§5.3) —
   closes unbounded spend on the MCP and CLI surfaces at once.

---

## 1. Repo topology

**Two divergent trees. Most facts below are branch-dependent — check §1 before trusting a number.**

```
… ea414bc ─┬─ fe9b4eb   master                        M0+M1+A17+M2 + a guard-fix pass
           └─ aa8752a ─ 634003a ─ e9e9b89             + M3, + eval harness, + HANDOVER.md
                        claude/context-review-5957e4
```

- `merge-base(master, M3) = ea414bc` — one commit *behind* master's HEAD.
- **`fe9b4eb` is NOT an ancestor of the M3 branch** (`git merge-base --is-ancestor` confirms). M3 is
  not "master plus M3".
- M3 range `ea414bc..e9e9b89`: 74 files changed, 43 added, 31 modified, 0 deleted, 0 renamed.
- `fe9b4eb` alone: 26 files changed.

| | `master` (fe9b4eb) | M3 branch (e9e9b89) |
|---|---|---|
| `src/*.ts` | 5,176 lines | 8,688 lines |
| ops in `operations.ts` | 7 | 12 (added `list_pages`, `delete_page`, `replace_page`, `ingest_file`, `search`) |
| migrations | `0001`–`0006` | `0001`–`0011` (11 numbered files; `0008`/`0010` are `.disabled` reverts, 9 applied) |
| `src/ingest/extract/`, `core/pack.ts` | absent | present |
| `doctor` checks | **46** (32 `add()` calls, 5 in two loops → 42 boolean + 4 fixtures) — README's "46" is correct **here** | **62** (47 `add()` calls, 5 in three loops → 58 boolean + 4 fixtures) — README's "46" is stale **here** |
| the `isDevEnv` guard fix (§6.1) | ✅ | ❌ |

### Ten files touched by both commits

`DECISIONS.md` · `src/ai/router.ts` · `src/answer/answer.ts` · `src/config.ts` ·
`src/core/context.ts` · `src/db/doctor.ts` · `src/db/migrate.ts` · `test/answer.test.ts` ·
`test/fixtures/expected-policies.json` · `test/live-gate.test.ts`

**Four genuinely conflict:**

| File | Conflict |
|---|---|
| `DECISIONS.md` | **Hard ID collision.** Both branches allocated **D66 and D67** from base D65 for unrelated decisions (master: "the guards were the thing that needed guarding" / SASLprep; M3: RLS-enforces-acl / knowledge succession). M3 continues to D90. Resolve before the file grows further. |
| `test/fixtures/expected-policies.json` | master: 17 entries, all carrying `permissive`. M3: 19 entries, none carrying `permissive`, rewritten quals for `acl && current_grants()`. |
| `src/ai/router.ts` | Both fixed the same `embed()` duplicate-index bug independently, differently. |
| `test/live-gate.test.ts` | Both rewrote the same broken meta-test from scratch, different detectors. |

**One merges clean and becomes wrong:** `src/core/context.ts`'s `visibleBy` docstring (master)
asserts no migration references `acl`; M3's `0007` makes that false.

### Other worktrees

Five total; four sit on `fe9b4eb`. The only **uncommitted work in the whole repo** is in
`rc-phone-connection-54833b` — a fourth variant of `live-gate.test.ts`. That directory's name does
not match its checked-out branch (`claude/strange-shaw-8faa4b`).

---

## 2. What the system is

Pooled multi-tenant SaaS knowledge brain — **upload → ask → cited, permission-scoped answer**.
Fork-and-narrow from gbrain (MIT, see `NOTICE`). TypeScript on Bun, Express 5, Postgres/Supabase with
pgvector.

**The one architectural commitment:** cross-tenant isolation lives in the *database*. The gating
predicate, in the actual policy form (not the shorthand — the wrapping matters, see below):

```sql
workspace_id = (SELECT NULLIF(current_setting('app.workspace', true), '')::uuid)
  AND acl && (SELECT public.current_grants())
```

The `(SELECT …)` wrappers are not decoration: they make each call an **InitPlan**, evaluated once
per query rather than per row, and an InitPlan output is a valid index-qual RHS — the only reason
`idx_pages_acl` / `idx_chunks_acl` are usable at all (`0007_acl_rls.sql:76-79`). Drop the wrapper as
"cleanup" and the ACL indexes silently stop being used.

The app connects as `cb_app`, a `NOSUPERUSER NOBYPASSRLS` role. Per request, the resolver builds a
**keyring** — an array of grant tags (`self:<principal>`, `ws:<workspace>`, eventually
`team:<id>`) — which `withScopedTx` serializes into the transaction-local `app.grants` GUC. `acl &&
current_grants()` is array overlap against that GUC. That's the whole enforcement mechanism.

> D66's argument, worth internalising before "simplifying" it: a policy is a total function over
> every query that will ever exist; an engine-side predicate is a partial function over the queries
> somebody remembered to write. It's not merely redundant to duplicate the check in a query — it
> teaches the next reader that the query is where ACL lives.

**Three planes, 13 tables.** Global identity (`principals`, `sessions` — self-scoped RLS) ·
workspace tenancy (`workspaces`, `workspace_members`, `invites`, `workspace_domain_blocks`) ·
ACL-bearing content (`pages`, `content_chunks`, `page_sources`, `quarantine`). The remaining three —
`teams`, `team_memberships`, `acl_grants` — are workspace-scoped but **dead**: schema, RLS and grants
exist, zero readers anywhere in `src/` or `scripts/` (see §5.1).

**Adding an op** — the one code shape worth having on hand:
```ts
defineOp({
  name: 'list_pages',
  description: '...',        // imperative — agents read this via /api/_ops and MCP tools/list
  params: z.object({...}).strict(),
  requiredRole: 'member',     // owner ⊃ admin ⊃ member
  mutating: false,
  handler: async (ctx, params) => withScopedTx(ctx, tx => tx`...`),
  // ^ RLS scopes the query via ctx's keyring. chat()/embed() must run OUTSIDE this callback —
  //   never hold a pooled connection across a model call (D6).
})
```
That's it — live on `/api/list_pages`, in `/api/_ops`, and in MCP `tools/list`, with role-gating,
validation, and shape-only logging applied by `dispatch.ts` automatically.

**Milestones**, used throughout the codebase and this doc:

| | |
|---|---|
| M0 | Foundations — schema, fail-closed context, AI router |
| M1 | Contract spine — ops registry, dispatch, REST/MCP |
| A17 | Answer-quality spike (between M1 and M2) — ingest, hybrid search, citations |
| M2 | Identity — Google OIDC, sessions, workspaces, invites |
| M3 | The brain loop — multi-format ingest, page lifecycle, four-arm hybrid search |
| M4 | Enforcement + doctor — nominally, though RLS actually landed early, at M3 (D66) |
| M5 | The demo web app — not started |
| M8 | Spend/usage accounting — not started; see §5.3 |

**Two controls you would otherwise "clean up":**
- **`current_grants()` is `STABLE`, never `IMMUTABLE`** — a security control, not an oversight. An
  immutable zero-arg function is constant-folded at plan time, and `client.ts` uses
  `prepare: !isPooler`, so on a direct connection a cached generic plan would bake in one
  principal's keyring and hand it to the next request.
- **`hnsw.iterative_scan = relaxed_order`** is set per-transaction as a *tenancy* control, not a
  perf knob. Without it, pgvector returns the globally-nearest `ef_search` candidates and RLS
  post-filters them — one large tenant silently truncates every other tenant's vector arm.
  Invisible with one tenant, which is why A17 shipped clean. (D51 filed it as perf; D58: "that was
  wrong.")

---

## 3. Where things live

```
src/             index.ts (Express app: /health + mounts) · boot.ts (deployment-shape gates)
                 config.ts (zod env schema)
src/db/          schema.sql (immutable baseline) · migrations/0001-0011 — 9 applied; 0008 and
                 0010 are checked-in reverts, suffixed .sql.disabled so the runner skips them
                 migrate.ts (runner + roles + grant matrix + definers) · doctor.ts · client.ts
src/core/        context.ts (fail-closed OperationContext + keyring) · pack.ts
src/auth/        google.ts resolver.ts session.ts workspaces.ts invites.ts membership.ts
                 csrf.ts ratelimit.ts blocklist.ts normalize.ts routes.ts log.ts
src/api/         operations.ts dispatch.ts server.ts mcp.ts call.ts tool-defs.ts
                 envelope.ts errors.ts redact.ts reqid.ts roles.ts dev-auth.ts
src/ingest/      file.ts (the waist) lifecycle.ts blocks.ts sanity.ts embed.ts chunk.ts import.ts
  extract/       detect.ts index.ts (the security boundary) worker.ts html.ts pdf.ts xlsx.ts docx.ts text.ts
                 (only pdf/docx/xlsx are third-party parsers — unpdf, mammoth, xlsx — run in the
                  subprocess; html/text/csv/json are parsed in-repo)
src/search/      hybrid.ts rrf.ts eval-score.ts
src/answer/      answer.ts prompt.ts
src/ai/          router.ts (one door for every model call) vector.ts
```

`.github/workflows/ci.yml` — **exists; `HANDOVER.md` never mentions it.** Two jobs: `offline`
(typecheck + unit + the two meta-tests) and `live` (the D16 leak canary with DB secrets). Bun pinned
to `1.3.14` in this file only — no `engines`/`.tool-versions` elsewhere. Dependencies are pinned
separately: `bun.lock` plus two exact specs in `package.json` (`@modelcontextprotocol/sdk` and
`xlsx`, the latter from `cdn.sheetjs.com`, not npm — see §4).

---

## 4. Setup gaps

`migrate` and `doctor` are unusually well documented (`docs/auth-setup.md:124-260` is a genuinely
good failure runbook). Past `bun run dev`, a newcomer following only `README.md` gets stuck:

- **No local-Postgres path.** Supabase account + network + three pooler strings before anything is
  verifiable. `src/config.ts` supports `DB_SSL=disable` but no doc mentions it. `docs/plan.md` lists
  a `docker-compose.yml` that does not exist.
- **`.env` is a symlink in some worktrees, not others.** Confirmed a real symlink to the main
  worktree in `context-review-5957e4/.env`; confirmed **absent entirely** in this worktree
  (`repo-handover-review-4971b4`). `ls -l .env` before running `cp` — in a worktree where it's a
  symlink, `cp` writes through it and overwrites the live file. **Never print `.env`.**
- **PG 15+ and pgvector 0.8+ are enforced in code** (`migrate.ts` throws below PG15; `doctor.ts`
  asserts pgvector ≥0.8) and documented nowhere a newcomer reads.
- **`jose` is a phantom dependency** — imported by `test/google.test.ts` and
  `test/helpers/fake-issuer.ts`, absent from `package.json`, resolving only via hoisting from
  `openid-client` and the MCP SDK. A transitive bump could break the fake-OIDC test suite with no
  visible declared dependency to blame.
- **`seed:a17` / `load:a17` are required** before `call`, `ingest-file` or `dump:top8` do anything,
  and appear only under an "Iterating on a migration" troubleshooting heading.
- **`doctor.ts:9` says run `migrate` twice** before trusting `doctor` (the idempotency regression a
  single run can't catch). Every documented path, and CI, runs it once.
- **Missing from `.env.example`:** `DB_STATEMENT_TIMEOUT`, `DB_IDLE_IN_TX_TIMEOUT`, `RERANK_MODEL`,
  `QUERY_EXPANSION`, `COHERE_API_KEY` (bypasses the zod config schema entirely), `CB_CLI_PRINCIPAL`,
  `CB_CLI_WORKSPACE`, `DATASET`.

---

## 5. Open work — ranked

### 5.1 Team scope — under-scoped by roughly an order of magnitude

`HANDOVER.md` frames it as five touch points with `resolver.ts:122` as "the one most likely to be
missed." Everything below that is missing:

- **No write path.** No op creates a team or assigns a member, and `narrowGrants` (`migrate.ts:294-
  296`) explicitly revokes `cb_app`'s INSERT/UPDATE/DELETE on all three of `acl_grants`, `teams`,
  `team_memberships`. A correct keyring would have nothing to read.
- **Chicken-and-egg on the read path.** The keyring must be built *before* `withScopedTx` opens
  (grants are GUCs set at transaction start), but `acl_grants` is itself RLS-protected on
  `workspace_id = app.workspace`. Resolving team grants needs a **sixth `SECURITY DEFINER`** in
  `cb_internal` plus a doctor fixture change. Not in the five touch points.
- **Ten call sites, not one.** `resolveGrants` is called at `auth/resolver.ts:122`, `api/call.ts:37`,
  `api/mcp.ts:24`, `api/dev-auth.ts:93`, and in six `scripts/` files — `load-a17-corpus.ts:34`,
  `ingest-file.ts:80`, `novabyte-eval.ts:67`, `measure-a17.ts:67`, `run-a17-eval.ts:27`,
  `dump-top8.ts:47` — including the NovaByte harness that is supposed to *prove* the fix. Patching
  only `resolver.ts` leaves team pages invisible on CLI and MCP.
- **`0007`'s slug indexes assume two scopes.** A third needs a third partial index, and `import.ts`
  matches on the *index name* to build its 409.
- **The spec is not in the repo.** `docs/enabling-team-scope.md` exists only at
  `~/Desktop/novabyte-test-dataset/docs/`, outside version control, reachable via a `$HOME`-relative
  default in `scripts/novabyte-eval.ts:23`. **A fresh clone has the #1 open item and no spec for it.
  Vendor this doc into `docs/` today — five minutes against a total loss.**

The `teams` / `team_memberships` / `acl_grants` substrate is entirely **dead** — schema, FKs,
indexes, RLS, zero readers. `GRANT_TAG_RE` already permits `team:`, so validation isn't the blocker
— its permissiveness hides that nothing downstream exists. Writing a `team:` tag today produces a
row invisible to everyone including its author, and **unrecoverable**: the same policy that hides it
blocks rewriting it.

### 5.2 "Readable" ≠ "publishable" — surfaced, unsolved

`answerQuestion(ctx, question)` — verified, exactly two parameters. `OperationContext` describes the
*asker*; nothing named `audience`/`publish`/`readership` exists anywhere in `src/`. So a request to
draft a company-wide FAQ can include private material the asker may legitimately read. Suggested
shape: an optional `audience` that filters retrieval to chunks whose ACL is a superset — enforce
structurally, not by asking the model to be careful. **Open founder decisions, not yet answered
anywhere:** is this M3 scope or later, and does it belong on `ask` or a future `draft`/`publish` op?

### 5.3 Rate limiting and spend — MCP *and* CLI

`apiLimiter` fires only at `server.ts:85`, in front of the Express `/api/:op` route. **Both**
`mcp.ts:91` and `call.ts:40` call `dispatchOp` bare. Since M3 that path carries `ask`, `search` and
`ingest_file` — all paid provider calls. No spend ledger, no per-workspace cap, no usage accounting
anywhere in `src/`; `docs/plan.md` defers it to M8. A looping agent on the stdio bridge can spend
without bound. **Fix by moving the limiter in front of `dispatchOp` itself**, not the Express route
— that's what makes it apply to all three transports at once.

### 5.4 Documentation

`README.md` is stale in nine ways, not the three `HANDOVER.md` lists: doctor is 62 not 46 **on the
M3 branch** (§1 — accurate on master); Status omits M3 entirely; `hybrid.ts` is described as
"keyword + vector" when it's four arms; Layout omits `pack.ts`, `vector.ts` and five ingest modules;
the test enumeration misses ~20 files; `README:92` still says "no remote machine credential until
M3" — M3 shipped and there still is none.

`docs/plan.md` poses eleven gate decisions (UC1–UC6, T1–T5) — **but its own "Post-review resolution
(2026-07-23)" section already answers all of them except T4** (whose text notes the ZDR default was
already chosen). They are not open. What's actually unreconciled is that resolution against
`DECISIONS.md`, several of whose entries (§7) overturn parts of it.

---

## 6. Findings recorded nowhere else

### 6.1 [critical] The M3 branch is missing master's auth guard fix

`NODE_ENV` is `z.string().default('development')`, so an **absent** variable arrives as the exact
value the dev allowlist exists to permit. `master`'s `fe9b4eb` fixed the *auth* gates by adding
`nodeEnvExplicit` and routing them through `isDevEnv(cfg) = nodeEnvExplicit &&
DEV_ENVS.has(NODE_ENV)`.

On the M3 branch, `src/api/dev-auth.ts:16,24,48,65` and `src/boot.ts:66` still call
`DEV_ENVS.has(cfg.NODE_ENV)` bare. (`src/db/migrate.ts`'s `migrate:reset` gate is bare on **both**
branches — master never fixed it either — so it is not part of this divergence; don't spend time
reconciling a file master never touched.)

Consequence: a deployment with `DEV_AUTH=1` and no `NODE_ENV` boots with the header-trusting
identity stub live **and** the missing-secrets gate skipped — forged `x-cb-*` headers then
authenticate as any principal in any workspace. Reachable only with `DEV_AUTH=1`, so it's a
defense-in-depth failure, not an open door — but the guard whose entire job is "stop `DEV_AUTH` in
prod" does not fire. **Fix this first when reconciling branches.**

Related: `DECISIONS.md` D29/D33 (§7) record that this same gate was *already* wrong once before, in
a different way, and fixed — the allowlist-vs-blocklist confusion. Treat any change near this gate
as high risk; it has now been broken and re-fixed on two independent occasions.

### 6.2 [moderate] CI mutates a shared database on every push to every branch

`ci.yml` runs `on: push: branches: ['**']`, and the `live` job executes `bun run migrate` against a
real Supabase project using repo secrets. A bad migration on any branch mutates the shared database;
a checksum-drifted branch bricks CI for every other branch. Arguably higher operational risk than
its position in this list suggests — it affects every contributor on every push, not one deployment
shape.

### 6.3 [moderate] The upload route requires no CSRF token — because none exists, by design

`csrf.ts:129-132` waves through any request with no session cookie that isn't `/auth/*`, and
`checkCsrf` (`csrf.ts:57`) returns ok for a client sending neither `Sec-Fetch-Site` nor `Origin`.
There is no CSRF *token* anywhere in this codebase — the guard is origin-signal only, by explicit
design. So the `server.ts:45-47` comment claiming an 8 MB body "has had to … present a valid CSRF
token" describes a control that does not exist; don't go looking for it or try to "restore" it. The
real gap: the only thing in front of the 8 MB `express.json` on `/api/ingest_file` is
`preAuthLimiter` at 300 req/min/IP — ~2.4 GB/min of buffering plus `JSON.parse`, unauthenticated,
before any identity exists. `apiLimiter` runs *after* the body is parsed and can't protect it.

### 6.4 [minor] `parseFramed` accepts a long read — fix needs a byte slice, not a string slice

`extract/index.ts:146-154` validates the declared length as a **minimum only**, then `JSON.parse`s
the whole body. Suffix contamination passes the frame check and throws a raw `SyntaxError` that
surfaces as a 500 instead of a typed error. **The obvious fix is wrong**: `declared` is a byte count
(`worker.ts` writes `payload.byteLength`) but `body` is a decoded UTF-16 string — `body.slice(0,
declared)` truncates by code unit, corrupting every multibyte (Devanagari/Tamil) payload. Slice the
raw buffer to `declared` bytes, then decode.

### 6.5 [minor] The empty-ACL CHECK does not reject empty ACLs

`CHECK (array_length(acl, 1) >= 1)` (`0007:110-111`, `0009:103,162`) does **not** reject `acl =
'{}'`: `array_length('{}', 1)` is NULL, `NULL >= 1` is NULL, and a CHECK passes when NULL. The row
`0007` calls "permanently invisible to every principal including its author, with no application
path to repair it" can still be inserted. Correct form: `cardinality(acl) >= 1`. Latent today
(`aclForScope` always returns one tag), but it's precisely the failure the constraint exists to
prevent, and doctor asserts nothing about it.

### 6.6 Smaller, each real

- **`doctor --update` silences only the fixture checks, not everything.** `diffFixture` writes the
  file and returns `ok: true` unconditionally, so grant/policy/column-grant/definer drift is
  rubber-stamped. The ~55 boolean assertions still run and can still fail, and `main` still exits
  non-zero on any failure. Don't read "green after --update" as "the run passed" — check which half.
- **`doctor.ts` crashes on a partially-migrated DB**, at the unconditional `page_sources` query
  (`doctor.ts:275`). Nothing is printed at all when this happens — results are accumulated and only
  rendered at the end — so the ~38 checks already evaluated are lost along with the rest.
- **Every index assertion in doctor reads `pg_indexes`**, which has no validity column. An INVALID
  index (left by a cancelled `CREATE INDEX CONCURRENTLY`) still reports a normal `indexdef` and
  passes every check.
- **`test/perf-recall.test.ts` does not exist.** `leak-canary.test.ts:5-7` says filtered-HNSW recall
  at scale, GUC-bleed concurrency, and pool headroom "are gated separately" in that file. They are
  covered nowhere.
- **`novabyte-eval.ts` writes results to the repo root** with no matching `.gitignore` entry — a
  full run leaves graded answers from a two-tenant dataset one `git add -A` from being committed.
- **`.claude/settings.local.json`** (untracked) carries a permanent allow-rule that reads `.env` via
  `awk`, printing `NODE_ENV`/`DEV_AUTH` verbatim and the *lengths* (not values) of `SESSION_SECRET`/
  `DATABASE_URL` — a standing pre-approval to read `.env` unattended, though it doesn't emit the two
  secrets themselves. Separately, 8 of its 40 allow rules are stale gbrain-era carryovers naming
  `dev/gbrain` or files that don't exist in this repo.

---

## 7. `DECISIONS.md` — entries later overturned

The log is honest and self-correcting, but **reading order is the hazard**: these state something a
later entry reversed, and most carry no forward pointer.

| Entry | Says | Reality |
|---|---|---|
| **D5** (and **D27**, identical claim) | `acl && grants` in engine queries at M3, RLS refinement at M4 | **Both halves overturned by D66.** Landed in RLS a milestone early (migration `0007`); engine-side enforcement *explicitly refused* — no `acl` appears anywhere in `src/search/`. Reading either leads you to add an ACL predicate to `hybridSearch`, which D66 argues is actively harmful. Neither has a forward pointer. |
| **D0.1** | "at M2 nothing reads the `acl`"; private is aspirational until "M4" | Closed by D66 (`0007_acl_rls.sql`) at **M3**, 546 lines later. D0.1's only forward pointer says "enforced at M4" — the wrong milestone, and names no entry. A reader following it looks under M4 and finds nothing. |
| **D29** | dev-auth is gated on `NODE_ENV != production AND DEV_AUTH=1` (a **blocklist**) | **Reversed by D33**: the gate is an *allowlist* — `NODE_ENV ∈ {development, test}` (`dev-auth.ts:16`, `config.ts:102`). D33 calls this "the sole barrier to cross-tenant reads in M1." Neither entry points at the other. See §6.1 for how this same gate was broken and re-fixed again, differently, on master. |
| **D24** | doctor is "46 checks" | 62, on the M3 branch (46 on master — see §1). D24 has already been corrected once in place. Treat any doctor count in `DECISIONS.md` as a timestamp, never a target. |
| **D70** | "three `// rls-exempt:` exemptions exist" | **Seven** now (4 in `doctor.ts`, 1 `migrate.ts`, 2 in `scripts/`). The property holds — each states a reason — but the count is what stands between "recorded reason" and "invisible hole", and it silently more than doubled. |
| **D51(c)** | three A17 perf items deferred: no GIN index, `hnsw.iterative_scan` never set, chunk inserts one-per-round-trip | **All three shipped, and one was misclassified.** `0006_fts_index.sql` adds the GIN index; `client.ts:215` sets `hnsw.iterative_scan` — **D58 reclassifies it as a tenancy control, not a latency knob** (§2); D65 batched the chunk inserts. D51 points forward to nothing. |
| **D25** | column-grant protects `google_sub` **and** `email` | `migrate.ts` grants `cb_auth` `update(name, email, email_normalized, updated_at)`. **Email is rewritable by the login lane** — only `google_sub` is protected, via `adopt_principal`'s `IS NULL` guard. |
| **D14** | pgvector ≥0.8 "gates the M0 docker image" | D22 replaced Docker with Supabase entirely. The floor is real; the docker clause is residue. |
| **D10** | roll-your-own OIDC chosen for the India data-residency pitch | **Rationale withdrawn as factually false** — the Supabase project is in Seoul (`aws-1-ap-northeast-2`). Undercuts D0's "India-first" framing and D21's Mumbai target, neither amended. Relocating is now a data migration, not a re-provision. |
| **D23** | use `-- migrate:no-transaction` for `CREATE INDEX CONCURRENTLY` | Stood as guidance for three milestones while **never having worked** — D88 found it and **fixed it** (`splitStatements`, one statement per round trip). `0011` is the first and only file to use the pragma; it works now. |
| **D34** | Design specified refresh-token rotation returning "the already-rotated pair" in a grace window | **Cut as unimplementable** — only SHA-256 hashes are stored, so the raw tokens don't exist to return. `sessions.refresh_hash` / `refresh_expires_at` remain NULL. Don't assume rotation exists because the columns do; it returns at M5. |

---

## 8. `HANDOVER.md` — corrections (M3 branch only; this file doesn't exist on master)

The file inventory, all extraction descriptions, the migration descriptions, "five new ops",
"nothing was deleted", and the arm weights **all verified true**. Corrections:

1. **Open item #3 is already done.** `UNIQUE (page_id, ord)` on `content_chunks` has existed since
   `0004_integrity_constraints.sql:16-17`, reaffirmed in `0005:35`. The "real tradeoff" it asks you
   to weigh is *today's* behaviour: `replacePage` already throws an undiagnosable 23505 at
   `lifecycle.ts:351`. **The real work is error mapping, not the index.**
2. **"`worker.ts` rebinds `console.*` before any import can log" is false.** Lines 17–27 are the
   module body; 29–33 are static ESM imports, and ESM evaluates dependencies depth-first *first*.
   Confirmed by bundling: the parser deps land at bundle line 49, the rebind at line 95,675 of
   95,716. Impact is bounded (prefix contamination fails the `CBX1` frame check). Fix: `await
   import()` the parsers inside `main()`.
3. **"migrations idempotent" holds only weakly.** `0011` claims DROPs at the top of each pair handle
   an INVALID index left by a cancelled build — there are no such pairs. `IF NOT EXISTS` matches on
   *name*, so a cancelled `CREATE INDEX CONCURRENTLY` leaves an INVALID index skipped forever.
   Doctor won't catch it either (§6.6).
4. **"Addresses by page ID"** — `lifecycle.ts` accepts either; it *prefers* ID and degrades on slug
   ambiguity.
5. **`pack.ts` is at `src/core/pack.ts`**, not `src/ingest/`, despite being listed under the ingest
   group.

**And the claim to stop repeating:** §5 of `HANDOVER.md` says *"Every guard touched in this session
was verified [by breaking it on purpose]."* **Not true, and it fails in the shape it warns about.**
`MAX_OUTPUT_BYTES`, `MAX_CONCURRENT`, `MAX_WAITING` have zero test references tree-wide.
`splitStatements` — added specifically because the no-transaction path was broken — has zero
coverage. The secret-leak probe's own comment says it spawns "from the REPO ROOT on purpose... this
reproduces the exact condition"; the next line is `cwd: mkdtempSync(tmpdir())` — **the probe cannot
fail for the reason it was written.** And the `cwd: CHILD_CWD` fix is still asserted by source
regex; redefining `CHILD_CWD` to `process.cwd()` keeps the test green and restores the leak. The
*pattern* is right and worth carrying forward. The claim of universal application is not.

---

## 9. What this review did not cover

- **`docs/plan.md` was read once, past the gate-resolution section (§5.4) — not deeply otherwise.**
  It's the only definition of M4/M5 beyond the one-liners in §2.
- **`DECISIONS.md` D66–D90 were not reconciled against `HANDOVER.md`'s narrative** of the same
  milestone — the one cross-check that would catch the handover drifting from the log.
- **`eval/a17-report.md` was not read in full.** All ten `Grade: [ ] pass [ ] fail` boxes ship
  **blank** — the human half of the A17 gate was never performed, while the automated half sits at
  a 1.000 ceiling. "523 pass / 0 fail" is not answer-quality evidence.
- **No live run of anything.** `typecheck` was executed; the test suite, `doctor`, and the
  migrations were not — all need a database. Every "live" number in this doc is reconciled
  statically against declared counts, not observed by running them.
- **No cross-model review.** Codex was logged out for the M3 session and was not used here either.
- **Unread as code:** `src/auth/{google,session,membership,blocklist,normalize,log,routes}.ts`,
  `src/api/{envelope,reqid,roles,tool-defs,errors,call}.ts`, `src/search/eval-score.ts`,
  `src/ai/vector.ts`, and all six `scripts/*a17*` files.
- **Extraction fixtures are generated**, so a generated PDF is the easiest PDF in existence.
  Two-column layouts, page-spanning tables and Devanagari are where real extraction fails and are
  untested.
