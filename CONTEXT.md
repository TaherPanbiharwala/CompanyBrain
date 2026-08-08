# CONTEXT.md — session bootstrap

Produced by an initial pass that read the whole codebase and all 96 `DECISIONS.md` entries then in
existence, adversarially verified every claim against the code, and **actually ran the system** —
followed by the M4 build and its own seven-pass review, which took the log to 101 entries (D0–D97).
Read this once instead of re-deriving it.

**`master` is the single trunk. Branch from it, merge back into it.** As of 2026-07-30 every branch
in the repo is an ancestor of master — the M3 line, the CONTEXT.md line and five stale copies were
all reconciled. There is no second tree to check any more; §1 records what that cost, because the
same shape will recur the moment work forks again.

**Four criticals and one minor were fixed in the same session that found them** — §6.1, §6.7, §6.8,
§6.9 and §6.5.
What remains open is listed in §5 and marked inline through §6 — nothing below claims to be fixed
unless it says so and names the commit.

**How this relates to the other docs:** `DECISIONS.md` is the reasoning and survives refactors —
trust it, with the corrections in §7. `HANDOVER.md` narrates the session that built M3 — trust it,
with the corrections in §8. `README.md` is stale in the ways §5.4 lists. This file is where the repo
actually *is*, and where those three get out of sync with the code or each other.

Written against `master` = **`2ac308a`**, then updated for **M4**, then for **M5a**. `master` is now
**`a9d43f1`** ("M5a: the web app, plus every fix from its pre-landing review"), six commits past
`72a06b6` (`4ea57d7`, `8f02d4b`, `4d4ff2c`, `8fc0be4`, `9d63033`, `a9d43f1`). **Those six carry a real
code diff** — 47 files, +5,165/−126 across `src/`, `test/` and the new `web/` tree (new `src/web.ts`,
rewritten `src/api/server.ts`, `src/auth/csrf.ts`, `src/ingest/lifecycle.ts`, `src/index.ts`, the
whole `web/` SPA, five new test files) — so this file's own standing rule has fired: **§6 and §10 were
measured against `0b614ef`/`72a06b6` and have been re-derived here against `a9d43f1`, in the same pass
that produced this edit.** Every file:line citation in §6 and §10 below has been re-checked; a handful
that were already wrong when written (pointing at the wrong lines even at `72a06b6`) are also
corrected. §10 is timestamped observation and decays fastest regardless — re-run it, don't trust it,
the next time master moves.

---

## 0. Start here

**`master` is the trunk. Branch from it; merge back into it.** Everything below describes master at
`a9d43f1` — the M4 line (`claude/context-md-review-73f2ab`) merged 2026-07-30 as a clean
fast-forward, then M5 Phase −1 (`4ea57d7`, `8f02d4b`), M5 Phase 0 (`4d4ff2c`, `8fc0be4`, `9d63033`)
and M5a (`a9d43f1`) landed on top — there is still no second tree to check (`git branch --no-merged
master` is empty, no stashes, every worktree clean). The repo now has a remote: `origin` →
`github.com:TaherPanbiharwala/CompanyBrain.git`. Before starting work, confirm your branch point is
master's HEAD and not an ancestor of it:
`git merge-base master HEAD` should equal `git rev-parse master`. That single check is what the whole
of §1 exists to prevent a repeat of.

**Working first-run** (Supabase already provisioned per `README.md` "Local dev"):
```bash
ls -l .env                            # if it's a symlink, do NOT `cp` onto it — see §4
cp .env.example .env                  # only if it's not a symlink
bun install                           # M3 added mammoth/unpdf/xlsx — a stale node_modules fails typecheck
bun run migrate && bun run migrate    # TWICE — doctor.ts:9's idempotency check needs a second run
bun run doctor                        # must be green: 73 checks
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

**Offline verify loop** (no DB): `bun run build:web && bun run typecheck && bun run test`. Three
things skip or fail otherwise. Live suites skip without a DB unless `CB_REQUIRE_LIVE_TESTS=1` (needs
Supabase + provider keys; a skip under that flag is a failure, by design). `test/web-mount.test.ts`
gates its SPA-serving assertions on `web/dist/index.html` existing (`:32`, `:97`, `:104`, `:280`) and
`dist/` is gitignored — without `build:web` they skip silently, which is the defect `ci.yml`'s
`build:web` step exists to prevent. And `test/session.test.ts` **fails 4 of 11** with `SESSION_SECRET`
empty (`session.ts:98-103` requires ≥32 chars) — despite the dev-login note above, set any ≥32-char
placeholder in `.env` before running the suite; it signs and verifies against itself and is not a
credential.

**M4 landed 2026-07-30, then was reviewed and fixed, then merged to `master`** (D93–D97):
`test/perf-recall.test.ts` now exists and carries the three properties a serial ladder cannot see;
the per-principal budget moved to `dispatchOp` rung 0, so REST and MCP are metered by one instance
(the CLI is reached but not effectively metered — see §5.3); doctor gained the two checks
`docs/plan.md:189` named and never got (**73 checks**). A seven-pass pre-landing review then found
that 7 of M4's own guards could pass with their subject *deleted* (not just broken — see D97, the
one-line lesson is "break the subject **and delete it**"), plus one real regression: doctor's new ACL
census had no `to_regclass` guard and aborted every check below it on a pre-`0009` database — the
exact defect class `7ae4d3e` already fixed once, back in the same file. All eight findings are fixed,
verified by deleting each guard's subject, and merged. M4's own gate — "an unfiltered query leaks
nothing and doctor is green" — is now met on evidence that survived adversarial review, not just
assertion. §5.3 and the perf-recall bullets in §6.6/§9 are updated accordingly.

**If you do only three things:**

1. ~~Vendor `docs/enabling-team-scope.md`~~ — **done in `4ea57d7`.** The spec is now in the repo at
   `docs/enabling-team-scope.md`, with a preface listing six ways it is stale against the current tree
   (`0007` is taken so the real migration is `0013`; touch point 3's keyring read runs before
   `withScopedTx` and silently returns zero rows; touch point 4's `.refine()` breaks module load).
   Read the preface before the body. Team scope itself is still unbuilt — see §5.1.
2. **Configure the GitHub repo secrets, or the leak canary is decorative** (§6.2). The remote now
   exists and the workflow was correctly gated before it — the risk that used to sit here is closed.
   But the seven secrets the `live` job reads were never set in GitHub Settings, so it fails on every
   merge to master while `offline` passes. D16 calls the canary sacred; today it runs only when a
   human types the command locally.
3. **Decide where spend accounting lives** (§5.3). M4 shipped a rate meter, not a cap — there is
   still no ledger, quota or usage table anywhere in `src/`. D18 puts it at M5; `docs/plan.md` says
   M8. Those disagree, and the decision is yours.

Then: the README is stale in five or six ways (§5.4 — re-count it, `a9d43f1` fixed the Status
paragraph and added `build:web` to the quickstart while §5.4 was still listing both as defects, and
§5.4's line numbers all shifted by ~14), and the "readable ≠ publishable" gap (§5.2) is a design
decision waiting on you, not an implementation task.

---

## 1. Repo state — one trunk, and what the fork cost

**`master` at `a9d43f1` contains everything.** All branches — the original seven, the M4 line
(`claude/context-md-review-73f2ab`, merged 2026-07-30 as a fast-forward, no new merge commit), and the
six M5 commits on top of `72a06b6` (Phase −1, Phase 0, M5a) — are ancestors of it (`git branch
--no-merged master` is empty), every worktree is clean, and there are no stashes. The repo now has a
remote: `origin` → `github.com:TaherPanbiharwala/CompanyBrain.git`. The milestones built: M0, M1, A17,
M2, M3, M4, **M5a**.

| | |
|---|---|
| ops in `operations.ts` | **14** (`rescope_pages` added; `delete_page` gained a `pageIds` batch arm) |
| migrations | **`0001`–`0012`**; `0008`/`0010` are `.disabled` reverts, **10 applied** |
| `DECISIONS.md` | **101 entries, D0–D97**, no duplicate IDs |
| `doctor` | **73 checks** |

### Why this section still exists

M3 was developed on a branch cut from **one commit behind** master's HEAD, so it never contained
master's guard-fix commit and the two lines diverged for days. Reconciling on 2026-07-30 cost a
five-conflict merge. Three of the five were the *same defect fixed twice, differently* — which is
the expensive kind, because a merge tool cannot tell you that both sides are right:

| File | Why it collided | Resolution |
|---|---|---|
| `test/live-gate.test.ts` | Both branches rewrote it from scratch after finding **different** ways it had failed | Kept the **union** — master's three-signal detector + floor, M3's paren-balanced weakened-gate scanner |
| `src/ai/router.ts` | Both fixed the same `embed()` index bug | Took M3's slot assignment: sorting catches a *missing* index, but a *duplicated* one still passes because the count comes out right |
| `DECISIONS.md` | Both allocated **D66/D67** from base D65 — one monotonic counter, two branches, no shared ref | M3 keeps 66–90 (referenced by number across code and docs); master's two became **D91/D92** |
| `test/fixtures/expected-policies.json` | master had the `permissive` column but 17 policies; M3 had 19 without it | Neither was right. Regenerated from the live DB and reviewed as a security change: exactly 19 `permissive` insertions, no policy added or removed |
| `src/config.ts` | `isDevEnv` was ported to M3 while master already had it | One word, resolved on fact |

### The two lessons, because both will recur

**A monotonic counter in an append-only file collides by construction the moment work forks.**
`DECISIONS.md` uses `D<n>`; the checked-in doctor fixtures have the same shape. Neither branch did
anything wrong.

**A clean textual merge is not a correct merge.** The last branch merged with **zero conflicts** and
produced a file that would not compile — two `REQUIRED_LIVE_SUITES` declarations in non-overlapping
regions. Git cannot see that; `bun run typecheck` did. Always typecheck and run the suites after a
merge, not just resolve the conflicts git shows you.

**And a branch-tip comparison can miss work entirely.** `claude/strange-shaw-8faa4b` reported "0
commits ahead" while holding real work as an **uncommitted file** in a worktree whose directory name
did not match its branch. Check `git status` in every worktree, not just the refs.

Backup refs from the reconciliation are at `refs/backup/20260730-121206/`.

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
| M4 | Enforcement + doctor — **done**. RLS itself landed early at M3 (D66); M4 closed the remaining gate (the perf/scale suite, the cross-transport rate meter, doctor's migrations-current + acl-coverage checks) and survived a seven-pass review (D93–D97) |
| M5 | Split M5a/M5b. **M5a done and merged** (`a9d43f1`) — Vite+React SPA at `/` (14 files under `web/src`), `src/web.ts`, CSP+HSTS, ask/upload/pages/invite surfaces; 3 web suites (`web-mount`, `web-invite-flow`, `web-render-safety`) plus `body-limits` and `answer-confidence`. Deployed to Railway. M5b (teams, members, operator panel, conversations, MCP-over-HTTP) not started; see `docs/screens.md` |
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
src/db/          schema.sql (immutable baseline) · migrations/0001-0012 — 10 applied; 0008 and
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
src/web.ts       serves the SPA: security headers, static mount, SPA fallback, in-process Vite dev

web/             the M5a frontend (Vite + React 19 + Tailwind 4, same-origin, no CORS anywhere)
  src/           App.tsx (18-line useRoute at :33-50, no react-router) main.tsx index.css (@theme tokens)
    lib/         api.ts (callOp + callAuth, the ONLY fetch layer; DOM-free by test)
    components/  AnswerView.tsx PageList.tsx Upload.tsx ErrorPanel.tsx Invite.tsx
                 ScopeBadge.tsx (the scope label on every hit — shared by AnswerView and PageList)
    screens/     SignIn.tsx CreateWorkspace.tsx AcceptInvite.tsx Home.tsx (Invite is a Home tab, not a route)
  dist/          gitignored; `bun run build:web` writes it and a non-loopback boot REQUIRES it
```

`.github/workflows/ci.yml` — **exists; `HANDOVER.md` never mentions it.** Two jobs: `offline`
(typecheck + `bun run build:web` + unit + the two meta-tests) and `live` (the D16 leak canary,
**master-only** since M5a Phase −1). The `build:web` step is not cosmetic: the SPA-serving
assertions in `test/web-mount.test.ts` are gated on `web/dist` existing, so without it they skipped
on every CI run, silently. **`live` is currently RED on every master push** — `gh secret list` is
empty, so none of `DATABASE_URL` / `DATABASE_ADMIN_URL` / `DATABASE_AUTH_URL` / `CB_APP_DB_PASSWORD`
/ `CB_AUTH_DB_PASSWORD` / `SESSION_SECRET` / `CB_MCP_*` exist in GitHub Settings, and the job dies at
`Apply migrations` in ~6s. `offline` passes. The D16 "canary runs in CI forever" guarantee is
therefore still not real: the file exists, the credentials do not. Configuring the repo secrets —
or standing up the second CI database §9 already asks for — is the open action. Bun pinned
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
  worktree. It is a real file at the repo root and a symlink in some worktrees, so this varies by
  where you are standing. `ls -l .env` before running `cp` — in a worktree where it's a
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
- **GitHub repo secrets were never configured.** `gh secret list` is empty, so the only automated
  proof of tenant isolation — the `live` job's leak canary — has never executed on a runner; see
  §3 and §6.2.

---

## 5. Open work — ranked

### 5.1 Team scope — under-scoped by roughly an order of magnitude

`HANDOVER.md` frames it as five touch points with `resolver.ts:122` as "the one most likely to be
missed." Everything below that is missing:

- **No write path.** No op creates a team or assigns a member, and `narrowGrants` (`migrate.ts:337`)
  explicitly revokes `cb_app`'s INSERT/UPDATE/DELETE on all three of `acl_grants` (`migrate.ts:353`),
  `teams` (`:354`) and `team_memberships` (`:355`). A correct keyring would have nothing to read.
- **Chicken-and-egg on the read path.** The keyring must be built *before* `withScopedTx` opens
  (grants are GUCs set at transaction start), but `acl_grants` is itself RLS-protected on
  `workspace_id = app.workspace`. Resolving team grants needs a **sixth `SECURITY DEFINER`** in
  `cb_internal` plus a doctor fixture change. Not in the five touch points.
- **Ten call sites, not one.** `resolveGrants` is called at `auth/resolver.ts:122`, `api/call.ts:37`,
  `api/mcp.ts:24`, `api/dev-auth.ts:98`, and in six `scripts/` files — `load-a17-corpus.ts:34`,
  `ingest-file.ts:80`, `novabyte-eval.ts:66`, `measure-a17.ts:67`, `run-a17-eval.ts:27`,
  `dump-top8.ts:47` — including the NovaByte harness that is supposed to *prove* the fix. Patching
  only `resolver.ts` leaves team pages invisible on CLI and MCP.
- **`0007`'s slug indexes assume two scopes.** A third needs a third partial index, and `import.ts`
  matches on the *index name* to build its 409.
- **The spec is vendored — this is DONE.** `docs/enabling-team-scope.md` is tracked in the repo as of
  `4ea57d7` ("M5 Phase -1: … vendor the team-scope spec"), so a fresh clone now has both the #1 open
  item and its spec. `scripts/novabyte-eval.ts:22` still defaults `DATASET` to
  `$HOME/Desktop/novabyte-test-dataset`, but only the ~105-page corpus lives out there now — the spec
  does not.

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

### 5.3 Rate limiting — **CLOSED at M4**. Spend accounting — still open (M5)

~~`apiLimiter` fires only at `server.ts:85`~~ — the per-principal budget now runs at **rung 0 of
`dispatchOp`** (D94), so REST and MCP are metered by one instance and a transport added later is
metered *by omission* rather than by someone remembering. **The CLI is reached but not effectively
metered:** `FixedWindowLimiter`'s buckets are a per-process Map and `call.ts` is one-shot, so a shell
loop starts a fresh bucket every time. Accepted, not fixed — it runs on a developer's own machine
against their own principal, and a shared store belongs with the M5 ledger. The opt-out is an explicit
`DispatchOpts` field taking a reason string, reachable only from in-process TypeScript.
`test/dispatch-limit.test.ts` source-scans `mcp.ts`/`call.ts`/`server.ts` to stop it drifting back to
REST-only. Note `ctx.remote` was considered as the discriminator and **rejected** — it is inverted
(`resolver.ts:123` is `remote:false` for a real browser session), so exempting `!remote` would
unmeter production; don't re-propose it.

**Still open:** this is a rate meter, not a spend cap. No ledger, per-workspace quota or usage
accounting exists anywhere in `src/` — D18 puts caps at M5, which is the entry to follow, not
`docs/plan.md`'s M8.

### 5.4 Documentation

`README.md` is stale in five ways, not the three `HANDOVER.md` lists — down from eight at the last
pass, because M5a closed the Status line, the missing web-UI mention, and the missing `build:web`
step (all three below, struck through). One of the original nine was a doctor-count complaint, and
that count (**73**, `README.md:54` and `:158`) now happens to **match** current reality (§1, §10);
it's re-verified here, not carried forward on trust — check it again next time rather than assuming
it stays lucky. What's still wrong:

- ~~Status omits M3 and M4~~ — **CLOSED at M5a**: `README.md:9-11` now lists M0, M1, A17, M2, M3, M4
  and M5a.
- **`hybrid.ts` is described as "keyword + vector"** (`README.md:149`) when it's **four** arms — the
  file's own comment says so (`hybrid.ts:87`: "FOUR arms, not three").
- **Layout omits `pack.ts`** (`src/core/`, `README.md:139`) **and `vector.ts`** (`src/ai/`,
  `README.md:146`) — both listed in this file's own §3.
- **Layout omits six ingest modules** (`README.md:147-148`, which names only `chunk.ts` and
  `import.ts`): `blocks.ts`, `embed.ts`, `extract/`, `file.ts`, `lifecycle.ts`, `sanity.ts`.
- **The test enumeration misses 29 of 52 test files** (`README.md:162-165`), including
  `perf-recall`, `boot`, `migrate`, `lifecycle`, `invites`, every M4-era addition, and all three M5a
  web tests (`web-mount`, `web-render-safety`, `web-invite-flow`).
- **`README:106-107`** still says "no remote machine credential until M3" — M3, M4 **and M5a** have
  shipped and there still is none.
- ~~No mention of the web UI at all~~ — **CLOSED at M5a**: `README.md:11` names M5a in the Built
  list, `:13-16` describe the sign-in → upload → cited-answer flow, and `:18-19` name the M5b
  remainder and link `docs/screens.md`. (The Layout section at `:134-158` still has no `web/` or
  `src/web.ts` entry, but that is the layout gap above, not a missing mention.)
- ~~`bun run build:web` absent from the quickstart~~ — **CLOSED at M5a**: it is step five of the
  quickstart block (`README.md:55`), and `:59-62` explain that it is optional for a loopback dev run
  but mandatory for any deploy, naming `assertWebBuildPresent()` and the silent-green-`/health`
  failure mode by hand.

`docs/plan.md` poses eleven gate decisions (UC1–UC6, T1–T5) — **but its own "Post-review resolution
(2026-07-23)" section already answers all of them except T4** (whose text notes the ZDR default was
already chosen). They are not open. What's actually unreconciled is that resolution against
`DECISIONS.md`, several of whose entries (§7) overturn parts of it.

---

## 6. Findings recorded nowhere else

### 6.1 [critical — **FIXED** `6410c8d`, merged to master] Dev-env gates defeated by an unset NODE_ENV

`NODE_ENV` is `z.string().default('development')`, so an **absent** variable arrives as the exact
value the dev allowlist exists to permit. Every dev-only gate tested `DEV_ENVS.has(cfg.NODE_ENV)`
directly, which meant a deployment with `DEV_AUTH=1` and no `NODE_ENV` booted with the
header-trusting identity stub live **and** the missing-secrets gate skipped — forged `x-cb-*` headers
then authenticating as any principal in any workspace. Reachable only with `DEV_AUTH=1`, so a
defense-in-depth failure rather than an open door, but the guard whose entire job was "stop
`DEV_AUTH` in prod" did not fire.

**Now:** `nodeEnvExplicit` + `isDevEnv(cfg)` in `config.ts` is the one answer, and all four
`dev-auth.ts` gates, `boot.ts`'s secrets block and `migrate:reset` route through it. `migrate:reset`
was the third of the three drifted copies `config.ts` names — it was bare on *both* branches, and is
lower severity only because `--yes-destroy` and `CB_CONFIRM_RESET` stand behind it. Also fixed:
`test/api.test.ts` gated on `NODE_ENV !== 'production'`, a negative match that would have disagreed
with the new gate and 401'd every request in a local run.

**The tests were a guard that did not guard, which is why this survived.** The old suite represented
"unset" as `NODE_ENV: ''` — not what an absent variable produces — so a test titled *"fails CLOSED
for unset NODE_ENV"* was green while the gate was open for exactly that input. The replacement uses
`nodeEnvExplicit: false`. And `assertDeploymentSafe` had **zero tests on either branch** despite
owning the more severe half; `test/boot.test.ts` is new. Verified red-then-green: reverting
`isDevEnv` to the bare form fails 5 tests across all three gates.

Related: `DECISIONS.md` D29/D33 (§7) record that this same gate was *already* wrong once before, in a
different way — the allowlist-vs-blocklist confusion. Treat any change near it as high risk; it has
now been broken and re-fixed on **three** independent occasions.

### 6.2 [closed — gated by `4ea57d7`; CI live job red on missing repo secrets] CI will migrate a shared DB from every branch

`ci.yml:14-15` still runs `on: push: branches: ['**']`, but that now only reaches the `offline` job
(typecheck + `build:web` + unit suite — no secrets, no database). `bun run migrate` moved to `:104`
and sits inside the `live` job, which is gated at `:80` to master pushes and `workflow_dispatch`
only, and serialised fleet-wide by its own concurrency group at `:83-85`. The per-ref group at
`:19-25` applies to `offline`, which is pure compute and free to cancel. Combined with checksum
immutability (`migrate.ts:655-678` — NULL-checksum rejection at `:662`, drift throw at `:669`), a WIP
migration applied from one branch and then edited would still brick CI permanently if two live runs
ever raced — which is exactly what the fleet-wide concurrency group now prevents.

**Re-graded again — this is now CLOSED, not latent.** `origin` exists
(`git@github.com:TaherPanbiharwala/CompanyBrain.git`) and the workflow runs on every push, so the
"arms itself on `git remote add`" framing has expired. The arming happened, and `4ea57d7` defused it
first: the `live` job — the only job that touches the database — is gated as described above, so no
two live runs migrate the shared Supabase project concurrently. Feature branches now run `offline`
only, which is pure compute. Live state today: `offline` is green; `live` FAILS because
`DATABASE_URL` / `DATABASE_ADMIN_URL` / `DATABASE_AUTH_URL` / `SESSION_SECRET` / `CB_MCP_*` were
never added under GitHub Settings → Secrets. That is a config task, not a defect — see §0 item 2 and
§3.

### 6.3 [moderate] The upload route requires no CSRF token — because none exists, by design

`csrf.ts:129-132` waves through any request with no session cookie that isn't `/auth/*`, and
`checkCsrf` (`csrf.ts:57`) returns ok for a client sending neither `Sec-Fetch-Site` nor `Origin`.
There is no CSRF *token* anywhere in this codebase — the guard is origin-signal only, by explicit
design. So the comment that used to sit at `server.ts:45-47`, claiming an 8 MB body "has had to …
present a valid CSRF token", described a control that does not exist.

**FIXED in M5a (`a9d43f1`, on master), and the fix itself needed a second pass — read both halves.**
The comment is gone and `requireValidSession` (`src/api/server.ts:140`, mounted at `:191` and `:193`)
now sits in front of every raised-limit parser. Its FIRST version gated on `hasSessionCookie`, i.e.
cookie PRESENCE with no shape or database check — which one forged header defeated: measured,
`Cookie: cb_session=junkjunk` plus a 9 MB body returned 413, meaning the 8 MB parser had already
engaged for a caller who authenticated nothing. That version reproduced the very failure it replaced,
one layer up. It now calls `resolveSessionRow`, which shape-checks from memory and then does one
indexed lookup.

Residual, stated honestly: an attacker with a well-formed forged token still costs one indexed read
per request, and `preAuthGuard` at 300 req/min/IP remains the actual flood control — `resolver.ts`
says so explicitly. What changed is the per-request cost, by ~1000x. `apiLimiter` still runs *after*
the body is parsed and still cannot protect it.

### 6.4 [minor] `parseFramed` accepts a long read — fix needs a byte slice, not a string slice

`extract/index.ts:146-154` validates the declared length as a **minimum only**, then `JSON.parse`s
the whole body. Suffix contamination passes the frame check and throws a raw `SyntaxError` that
surfaces as a 500 instead of a typed error. **The obvious fix is wrong**: `declared` is a byte count
(`worker.ts` writes `payload.byteLength`) but `body` is a decoded UTF-16 string — `body.slice(0,
declared)` truncates by code unit, corrupting every multibyte (Devanagari/Tamil) payload. Slice the
raw buffer to `declared` bytes, then decode.

### 6.5 [minor — **FIXED** `7ae4d3e` via migration `0012`] The empty-ACL CHECK rejected nothing

`CHECK (array_length(acl, 1) >= 1)` (`0007:110-111`, `0009:103,162`) does **not** reject `acl =
'{}'`: `array_length('{}', 1)` is NULL, `NULL >= 1` is NULL, and a CHECK passes when NULL. The row
`0007` calls "permanently invisible to every principal including its author, with no application
path to repair it" can still be inserted. Correct form: `cardinality(acl) >= 1`. Latent today
(`aclForScope` always returns one tag), but it's precisely the failure the constraint exists to
prevent, and doctor asserts nothing about it.

### 6.6 Smaller, each real

- **`doctor --update` silences only the fixture checks, not everything.** `diffFixture` writes the
  file and returns `ok: true` unconditionally, so grant/policy/column-grant/definer drift is
  rubber-stamped. The ~69 boolean assertions (up from ~55 pre-M4 — the migrations-current and
  acl-tag-coverage checks added at M4 all live on this side) still run and can still fail, and `main`
  still exits non-zero on any failure. Don't read "green after --update" as "the run passed" — check
  which half.
- ~~`doctor.ts` crashes on a partially-migrated DB~~ — **FIXED** `7ae4d3e`. The `page_sources` query
  is guarded on `to_regclass`, and checks now STREAM as each verdict is reached, so a throw costs the
  checks *after* it rather than every result already proven. The `current_grants() exists` probe was
  split out of the same SELECT too: it shared one with `has_function_privilege()`, which *raises*
  when the function is absent, so the check whose whole purpose was reporting "0007 not applied"
  threw before it could report.
- ~~Every index assertion reads `pg_indexes`, which has no validity column~~ — **FIXED** `7ae4d3e`.
  An `indisvalid` assertion now catches an INVALID index (remedy: `REINDEX INDEX CONCURRENTLY`).
  Added alongside it: a `pg_constraint` assertion on the acl CHECKs by DEFINITION, since nothing
  queried `pg_constraint` — which is exactly how four constraints enforcing nothing survived a
  62-check verifier.
- ~~`test/perf-recall.test.ts` does not exist~~ — **FIXED at M4 (D93/D96).** All three properties
  `leak-canary.test.ts:5-7` promised are now in that file, gated on `CB_RUN_PERF_TESTS` rather than
  `CB_REQUIRE_LIVE_TESTS` so the sacred canary's flag is never under pressure from a timing flake.
- **`novabyte-eval.ts` writes results to the repo root** with no matching `.gitignore` entry — a
  full run leaves graded answers from a two-tenant dataset one `git add -A` from being committed.
- **`.claude/settings.local.json`** (untracked) carries a permanent allow-rule that reads `.env` via
  `awk`, printing `NODE_ENV`/`DEV_AUTH` verbatim and the *lengths* (not values) of `SESSION_SECRET`/
  `DATABASE_URL` — a standing pre-approval to read `.env` unattended, though it doesn't emit the two
  secrets themselves. Separately, 8 of its 40 allow rules are stale gbrain-era carryovers naming
  `dev/gbrain` or files that don't exist in this repo.

### 6.7 [critical — **FIXED** `ec43ff8`] The A17 report's numbers described a superseded engine

`eval/a17-report.md:4-6` reports `hit@1: 1.00 / hit@3: 1.00 / MRR: 1.00`. Re-scoring the **committed
baseline** (`eval/top8-baseline.txt`) against the **committed qrels** (`eval/a17-qrels.json`) by hand
gives **hit@1 0.90, hit@3 1.00, MRR 0.95**.

q10 is the regression. `top8-baseline.txt:98-99` ranks `northstar-robotics#0` first for *"Who leads
sales at Northstar Robotics and which customer deal have they closed?"*, but that question's
`relevantSlugs` are `["sara-kim", "finch-logistics"]` — `northstar-robotics` is not relevant. The
baseline was added by `aa8752a`, the same commit that rewrote hybrid search, so the report's numbers
predate the current engine by one rewrite and now **overstate retrieval**.

This is exactly the silent ranking regression `dump-top8.ts:5-7` was built to detect. It fired, into
a committed file, and nobody looked. Two consequences: the "saturated 1.000 benchmark" framing in
`HANDOVER.md:215` and in `hybrid.ts`'s own comments is **no longer true**, and the A17 go/no-go rests
on a stale number.

### 6.8 [critical — **FIXED** `bdcc9d3`] CSV/XLSX shifted every column after a blank cell

`text.ts:100,103` and `xlsx.ts:147,160` drop empty cells with `.filter(Boolean)` / `if (t)` *before*
joining, while the header row is built the same way. Every value after a blank cell moves left one
column relative to the header the model is shown. Executed against the real extractor and chunker in
this worktree:

```
input CSV : Item,Qty,Rate,Date  /  Robot arm,,123456,2026-03-12
header    : "Item | Qty | Rate | Date"
row       : "Robot arm | 123456 | 2026-03-12"
```
The model is shown **Qty = 123456** and **Rate = 2026-03-12**, and `ask` answers "the quantity was
123,456" with a correct-looking citation. No error, no `degraded` flag, no trace.

This is the same class of defect `HANDOVER.md:74-82` congratulates the milestone for catching
(merged cells, date serials, uncached formulas) — in the same two files, missed. A blank cell in a
spreadsheet is not an edge case.

**FIX (`bdcc9d3`, on master).** One shared rule, `joinRow()` in
`src/ingest/blocks.ts`, replacing `.filter(Boolean)` in `text.ts` and `if (t) parts.push(t)` in
`xlsx.ts`. Interior empties are kept (positional); only trailing empties are dropped (a short row is
unambiguous). An uncached formula now pushes `''` to hold its column while `skipped` still records
the loss, so the existing degradation accounting is unchanged. `xlsx.ts`'s header comment now says
**six** silent-corruption classes, not five.

Verified red-then-green per this repo's own §8 discipline: reverting `joinRow` to `filter(Boolean)`
turns both regression tests red, and the blank-row control test passes under both. `typecheck` clean;
offline **392 pass / 0 fail**; live **527 pass / 1 skip / 0 fail** — exactly +4 on the 523 baseline,
the 4 new tests, zero regressions. The xlsx case is built in memory on purpose: `sample.xlsx` has no
blank cell, so a fixture-driven test would pass against the shifted output too.

### 6.9 [critical — **FIXED** `ee4461c`] `chunkBlocks`' token ceiling bounded nothing it emitted

`chunk.ts:331` compares `bufTokens + blockTokens > target`, but `bufTokens` counts **only block
text**; the heading-path prefix and the repeated table/sheet header are prepended in `flush()` at
`:287` and re-prepended per split piece at `:315` — *after* the size decision. Measured end-to-end
(`extractCsv → assessExtraction → chunkBlocks → planBatches`):

- 5,000 columns × 3 rows, 114 KB: sanity `ok=true`, 44 chunks, **every chunk 17,588–17,772 tokens —
  2.3× the 7,500 cap** → `embedAll` throws (`embed.ts:92`) → 500.

The guard is real, the accounting is incomplete, and the failure lands as an untyped 500 on a file
that passed every upstream check. Note `xlsx.ts:144,154` also leaves the **column axis
(`range.e.c`, attacker-declared via `!ref`) entirely unclamped** while rows, sheets and merge ranges
are all clamped — that is the input that reaches this path.

### 6.10 [moderate] The NovaByte harness — real defects, mostly latent, one live

Verified against the actual dataset at `~/Desktop/novabyte-test-dataset`. Pass 1's stronger claims
were **refuted**; what survives:

- **LIVE.** `novabyte-score.ts:48-50` inverts UP/DOWN whenever a relevant doc is missing on either
  side, because `findIndex` returns `-1`. A question that fell from rank 3 to *nowhere* prints
  ` UP`; one that went from nowhere to rank 1 prints `DOWN`. The aggregate MRR is correct (guarded
  by `if (firstRel >= 0)`), so summary and detail contradict each other silently.
- **LIVE.** `leak_canary`'s `forbidden_strings` — the actual canaries — frequently live *only* on
  team-scoped pages that `:107` never ingests. **lc-021: 7 of 7 canaries unreachable**; lc-022: 6 of
  7; lc-020: 5 of 8. The designed leak target was never loaded, leaving `forbidden_workspace` as the
  case's sole surviving assertion.
- **LIVE.** A parse failure or successful injection sets `citations: []` (`answer.ts:98`), which
  silently disarms the four citation-driven checks. Narrower than pass 1 claimed —
  `must_not_contain`/`forbidden_strings` grade the **answer text** and the injection suite
  hard-fails on empty `cited` (16/16) — but the four checks are genuinely disarmed.
- **LATENT.** Slug-keyed `must_cite`/`must_not_cite` (`:194-198`) and `scopeBySlug` (`:48`,
  last-write-wins) are wrong for the five cross-tenant collision slugs, but every live collision case
  is *also* covered by the pageId-keyed `must_cite_from_workspace` + `forbidden_workspace` checks. No
  case mis-grades today.
- ~~`byId` is dead code; `searchFn` dispatches by question text~~ — **FIXED** `4d4ff2c`. `byId` is
  gone; `byQuestion` (`novabyte-eval.ts:321-332`) is built with a duplicate check that throws, naming
  both clashing row ids, and `searchFn` (`:335`) reads it. The invariant this bullet recorded as
  latent is now asserted rather than assumed.
- **Dead fields.** `expectation`, `expected_answer` and `may_cite` are read by nothing. No spec is
  assertion-free, so nothing passes vacuously — but the 167 `not_found` specs grade purely
  negatively: a confident fabrication that cites nothing and dodges the listed strings passes.
- `degraded` is discarded at every call site, so a run under a dead embedder reports keyword-only
  numbers as real ones. Same defect in `dump-top8.ts:61`, where it can commit a **degraded baseline**.

### 6.11 [moderate] Retrieval and router: five controls that do not constrain what they claim

- `hybrid.ts:318` applies `ARM_LIMIT` (20) to the vector arm **before** `MAX_PER_PAGE` (3) is applied
  at `:375`/`:389`, so the per-page cap cannot prevent the one-document flooding its own comment
  (`:76-80`) says it exists to prevent.
- `hybrid.ts:471-476` checks the reranker's answer by **length, not membership**, so a provider
  returning a duplicated index silently duplicates one chunk and drops another — the exact
  "recall cut disguised as a reordering" the comment says it is guarding against.
- `router.ts:374` (`rerank`, declared `:373`) and `:271` (`embed`, declared `:270`) call
  `requireScope()` and **discard the return value**; only `chat()` reads it (`:227`). The rerank
  docstring's ZDR guarantee is one the code cannot make.
- `answer.ts:53-54`'s `scrubMarkers` regex cannot match comma-joined citations, and the model
  **demonstrably emits that form** — `a17-report.md:12` ends `...and firmware [1, 3].` The test
  titled "no dangling footnote, ever" cannot see it.
- `lifecycle.ts:162` (in `requireWriteAccess`, declared at `:161`) compares `page.owner_principal`
  (raw `text`) byte-for-byte against `ctx.principal`, while `selfGrant` lowercases (`context.ts:69`).
  The same case-drift hazard the grant path documents, on the sole authorization check for
  `delete_page`/`replace_page`.

### 6.12 [moderate] `ingest-file` CLI writes values the API contract declares impossible

`scripts/ingest-file.ts:19-22`'s `flag()` returns `argv[i+1]` unconditionally, so
`--slug --title X` yields `slug === "--title"`. Nothing downstream re-validates: `importFile`
checks only `bytes.byteLength` (`file.ts:47-57`), `pages.slug` has no CHECK constraint
(`schema.sql:196`), and the zod regex lives only at the op boundary (`src/api/operations.ts:295`, and
`:121` for the paste ops) which the CLI bypasses by importing `importFile` directly. Also: `--slug ""`
defeats the `?? slugFromFilename`
fallback (empty string is not nullish); `flagAll('tag')` enforces neither the 50-tag nor 64-char cap.

And `slugFromFilename` itself is wrong: it strips leading hyphens only, so `.hidden.txt → ".hidden"`
and `_private.md → "_private"` — both rejected by the op regex. Its comment claims it matches the
op's charset "so the CLI and the API cannot disagree." They do. (`--scope`/`--kind` are genuinely
safe — both are membership-checked against closed lists.)

### 6.13 [critical — live on the Seoul project; fix is dashboard-side, not in this repo] Supabase's Data API is a second, RLS-bypassing door into every table

Found 2026-08-08 while choosing security options for a replacement Supabase project, by querying the
live database rather than reading the dashboard. **This repo has never used Supabase's client SDK —
zero references to `supabase-js`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` or `/rest/v1/` anywhere in
`src/`, `web/`, `scripts/` or `package.json`.** Every connection this codebase makes is a direct
Postgres one through `postgres.js` as `cb_app`/`cb_auth`/`postgres`. The Data API was therefore never
a designed surface — it was on by default, and nothing in the repo knew it existed.

What the live Seoul project actually shows:

- `anon`, `authenticated` and `service_role` all exist, and each holds
  `SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER` on **every** table in `public` —
  `pages`, `content_chunks`, `sessions`, `principals`, `acl_grants`, `page_sources`, `quarantine`,
  the lot. That is the "Automatically expose new tables" default, applied to a schema built entirely
  by `migrate.ts`, which never granted any of it.
- **`service_role` has `rolbypassrls = true`.** Its key is an unrestricted master key to every
  workspace, every principal and every session, and no policy in `0007_acl_rls.sql` constrains it.
- The REST gateway is **live**: `https://<ref>.supabase.co/rest/v1/pages` answers with PostgREST's
  own `401 {"message":"Invalid API key"}`, i.e. it is serving and rejecting a bad key — so a real key
  is accepted.

Two facts bound the blast radius, and both are worth recording because they are structural, not luck:

1. **`anon` and `authenticated` are `rolbypassrls = false`, and every content policy is
   GUC-gated.** `content_chunks_ws` / `pages_ws` read `current_setting('app.workspace', true)` and
   `current_grants()`, which **only** `withScopedTx` ever sets. A PostgREST connection never sets
   them, `NULLIF` yields `NULL`, `acl && NULL` is `NULL` not `TRUE`, and RLS requires `TRUE`. The
   fail-closed discipline `0007_acl_rls.sql:28-34` describes protects a path nobody wrote it for.
   Note the policies are scoped to `PUBLIC`, not to `cb_app` — so they *do* apply to these roles;
   it is the GUC gate, not the role list, doing the work.
2. **None of the three roles has `rolcanlogin`.** They cannot open a raw Postgres connection at all.
   The REST gateway is the only door, which is why turning it off is a *complete* fix rather than a
   partial one.

**Fix (dashboard, both projects — there is no code change to make):** Project Settings → Data API →
disable **Enable Data API** and **Automatically expose new tables**. Rotate the JWT secret on the
Seoul project, since its `service_role` key has been live and unaudited for the project's whole
lifetime (no evidence of use, and none is obtainable from inside this repo). Leave **Enable
automatic RLS** off: migrations already `ENABLE ROW LEVEL SECURITY` explicitly on every table and
`doctor.ts` asserts both "every public table has RLS ENABLED" and "no table is RLS-enabled with zero
policies", so the event trigger it installs is redundant and untracked by our own tooling.

**Why `doctor` did not catch this, which is the durable lesson.** Its 75 checks are thorough about
`cb_app`/`cb_auth` — `expected-grants.json` and `expected-column-grants.json` pin their privileges
exactly — but the census only ever asks about the roles this repo creates. A role the *platform*
adds, holding grants the platform issued, is outside every fixture. Worth a check if the Data API is
ever deliberately enabled: assert `anon`/`authenticated` hold no privilege on any `public` table, and
that no role other than `postgres` has `rolbypassrls`.

---

## 7. `DECISIONS.md` — entries later overturned

The log is honest and self-correcting, but **reading order is the hazard**: these state something a
later entry reversed, and most carry no forward pointer.

| Entry | Says | Reality |
|---|---|---|
| **D5** (and **D27**, identical claim) | `acl && grants` in engine queries at M3, RLS refinement at M4 | **Both halves overturned by D66.** Landed in RLS a milestone early (migration `0007`); engine-side enforcement *explicitly refused* — no `acl` appears anywhere in `src/search/`. Reading either leads you to add an ACL predicate to `hybridSearch`, which D66 argues is actively harmful. Neither has a forward pointer. |
| **D0.1** | "at M2 nothing reads the `acl`"; private is aspirational until "M4" | Closed by D66 (`0007_acl_rls.sql`) at **M3**, 546 lines later. D0.1's only forward pointer says "enforced at M4" — the wrong milestone, and names no entry. A reader following it looks under M4 and finds nothing. |
| **D29** | dev-auth is gated on `NODE_ENV != production AND DEV_AUTH=1` (a **blocklist**) | **Reversed by D33**: the gate is an *allowlist* — `NODE_ENV ∈ {development, test}` (`dev-auth.ts:16`, `config.ts:102`). D33 calls this "the sole barrier to cross-tenant reads in M1." Neither entry points at the other. See §6.1 for how this same gate was broken and re-fixed again, differently, on master. |
| **D24** | doctor is "46 checks" | **73** today, and it has been 46, 62, 65, 72 and 73 within a fortnight. D24 was already corrected once in place and went stale again immediately — as did this very row, which still said 72 after the count moved to 73. Treat any doctor count in `DECISIONS.md` — or in this file — as a timestamp, never a target. |
| **D70** | "three `// rls-exempt:` exemptions exist" | **Thirteen** now, and still climbing (three when D70 was written, seven at the pass-2 review, nine after `7ae4d3e`, eleven after M4's first review pass `0b614ef` added the acl census and the scope/acl count, **thirteen** after `cc1ea50` added the two checks §0 already names — verified by blaming each of the 13 current markers to its introducing commit). The property holds — each states a reason — but the count is what stands between "recorded reason" and "invisible hole", and it has more than quadrupled since D70 was written. |
| **D51(c)** | three A17 perf items deferred: no GIN index, `hnsw.iterative_scan` never set, chunk inserts one-per-round-trip | **All three shipped; one was misclassified and one did not work.** `client.ts:215` sets `hnsw.iterative_scan` — **D58 reclassifies it as a tenancy control, not a latency knob** (§2); D65 batched the chunk inserts. The GIN index (`0006_fts_index.sql`) shipped and was **never once chosen by the planner** — measured at 609 pages / 2,829 chunks, where the keyword arm was 3,712ms of a 3,812ms statement because `to_tsvector` was recomputed per visible chunk, three times over. `0013_chunk_tsvector.sql` replaces the expression with a STORED generated column and drops 0006's index; the arm is 43ms. See `bun run explain:search`. |
| **D25** | column-grant protects `google_sub` **and** `email` | `migrate.ts` grants `cb_auth` `update(name, email, email_normalized, updated_at)`. **Email is rewritable by the login lane** — only `google_sub` is protected, via `adopt_principal`'s `IS NULL` guard. |
| **D14** | pgvector ≥0.8 "gates the M0 docker image" | D22 replaced Docker with Supabase entirely. The floor is real; the docker clause is residue. |
| **D10** | roll-your-own OIDC chosen for the India data-residency pitch | **Rationale withdrawn as factually false** — the Supabase project is in Seoul (`aws-1-ap-northeast-2`). Undercuts D0's "India-first" framing and D21's Mumbai target, neither amended. Relocating is now a data migration, not a re-provision. |
| **D23** | use `-- migrate:no-transaction` for `CREATE INDEX CONCURRENTLY` | Stood as guidance for three milestones while **never having worked** — D88 found it and **fixed it** (`splitStatements`, one statement per round trip). `0011` is the first and only file to use the pragma; it works now. |
| **D34** | Design specified refresh-token rotation returning "the already-rotated pair" in a grace window | **Cut as unimplementable** — only SHA-256 hashes are stored, so the raw tokens don't exist to return. `sessions.refresh_hash` / `refresh_expires_at` remain NULL. Don't assume rotation exists because the columns do; it returns at M5. |

**Pass 2 additions.** D70's "three exemptions" is confirmed wrong — **seven** markers existed at
that review pass (now **thirteen**; see the D70 row above for the current count, the commits that
added each batch, and why this paragraph no longer repeats specific line numbers — they drifted as
the files changed, and a second stale count sitting next to the first one is exactly the failure
mode being fixed here). And **D68's "Two consequences" enumeration is incomplete**: a third exists and
the same session had to fix it — `0007`'s partial slug indexes are unusable for a scope-less slug
lookup, which is why `0011` had to add `idx_pages_ws_slug` back (`doctor.ts:327-329`: "Both are read
paths whose index went missing silently"). Also minor drift: D70's "one of ten live suites" is now
twelve.

---

## 8. `HANDOVER.md` — corrections (now on master, merged with the M3 line)

The file inventory, all extraction descriptions, the migration descriptions, "five new ops",
"nothing was deleted", and the arm weights **all verified true**. Corrections:

1. **Open item #3 is already done.** `UNIQUE (page_id, ord)` on `content_chunks` has existed since
   `0004_integrity_constraints.sql:16-17`, reaffirmed in `0005:35`. The "real tradeoff" it asks you
   to weigh is *today's* behaviour: `replacePage` already throws an undiagnosable 23505 at
   `lifecycle.ts:355-356` (the `insert into content_chunks`). **The real work is error mapping, not
   the index.**
2. **"`worker.ts` rebinds `console.*` before any import can log" is false.** Lines 17–27 are the
   module body; 29–33 are static ESM imports, and ESM evaluates dependencies depth-first *first*.
   Confirmed by bundling (re-measured at `a9d43f1`; these two numbers move with `bun.lock` — the
   load-bearing fact is that the rebind is last, not the exact offsets): the parser deps land at
   bundle line 49, the rebind at line 95,759 of 95,799. Impact is bounded (prefix contamination fails
   the `CBX1` frame check). Fix: `await import()` the parsers inside `main()`.
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

### Pass 2: D66–D90 reconciled against the narrative (the cross-check pass 1 skipped)

One outright **contradiction**, and six decisions the narrative drops:

- **Wrong.** §4 says "A relevance floor and autocut were both **measured and rejected**"
  (`HANDOVER.md:151-152`). D78 says the floor was rejected but **autocut was built and shipped OFF**
  — written, tested, logging its dropped count, so enabling it is a constant change. "Rejected"
  would send someone to rebuild what already exists.
- **D76's second half is missing entirely**: `replace_page` **refuses** any page carrying a
  `page_sources` row. A user-visible API refusal, documented nowhere in §3 or §4.
- **D70 is unrepresented anywhere** — neither `test/scoped-tx-guard.test.ts` nor
  `.github/workflows/ci.yml` appears in the whole file. Compounds §6.2: the next session does not
  know CI exists.
- **D67 is unrepresented**, including its forward obligation: until a transfer path ships, an
  offboarded author's private pages are **orphaned**. That belongs in "Where to pick up".
- **D86** gets no sentence despite the header claiming D83–D86 (`kind` validated by a zod enum at
  the op boundary).
- **D82's own caveat is dropped**: the Cohere wire format in `rerank()` has **never been verified
  against a live provider**. §6's "Known limits of what is green" should carry that.
- **D79's primary finding is missing** — §3 records only the `LIMIT` move, not that a `pages`-based
  title arm emits page ids no chunk join can satisfy, so every title hit silently returns nothing.

Two §3 rows are also inaccurate: the `doctor.ts` row claims "four index assertions — on the
**expression**"; there are **five** index checks and only **two** read `indexdef` (§6.6). And the
`0007`/`0009` rows omit the partial index pairs (slug, sha), making D68's and D73's work unlocatable
from the narrative.

---

## 9. What is still not covered (rewritten after pass 2 — most of pass 1's gaps are closed)

**Closed by pass 2**, so do not spend budget re-covering: the D66–D90 vs `HANDOVER.md` reconciliation
(§8); `eval/a17-report.md`; and ~1,000 lines of previously unread in-diff code (`novabyte-eval.ts`,
`ingest-file.ts`, `dump-top8.ts`, `errors.ts`, `session.ts`). **The live run (§10) is NOT closed** —
it was measured before M5a and every number in it has moved. Re-run it before trusting a single row.

**A17 answer quality is now graded, and it is good.** All ten answers were checked line by line
against `test/fixtures/a17-corpus/`: **zero hallucinations, zero mis-citations**, every `[n]`
resolves to a document that supports the claim. Two sub-threshold imprecisions only (q7 says a rate
limit "was bumped" where the source records a decision; q4 omits that 8% was the *opening*
position). **The human half of the A17 gate can be closed from the repo today** — no database, no
API key, no re-run — because the corpus is checked in and the docs are tiny. It cannot be closed
from the report alone: `run-a17-eval.ts:82-83` writes slug names, never the evidence text. Note the
grade verifies each answer against the *document*, not against the chunk actually retrieved, and the
retrieval numbers above it are stale (§6.7).

**Still genuinely uncovered:**

- **The web app's behaviour.** `web/src` is 14 files / ~2,100 lines of React and nothing renders it
  under test. The three web suites are static source scans by explicit design —
  `test/web-render-safety.test.ts:17` ("A source scan rather than a render test, deliberately. There
  is no DOM test runner in this repo") and `test/web-invite-flow.test.ts:9-11`. They pin the *shape*
  of the source (no `dangerouslySetInnerHTML`, guard ordering, mount order); they cannot catch a
  component that renders the wrong thing. Adding a DOM runner is a real decision, not an oversight —
  but the gap belongs on this list.
- **Extraction on real documents.** All eight fixtures are generated. Two-column PDFs, page-spanning
  tables, scanned pages and Devanagari/Tamil remain untested — and §6.8 and §6.9 both landed in
  exactly this blind spot (a blank CSV cell; a wide sheet). The next defect of that shape will too.
- **Concurrency and scale — now covered, with two findings.** `test/perf-recall.test.ts` exists
  (M4): GUC bleed on a `max=1` pool, filtered-HNSW recall, and pool headroom under six concurrent
  answers. Two things it established that no document had recorded. **(1)** `STABLE` on
  `current_grants()` is the *sole* barrier to the plan-time fold — measured across four clones,
  neither `LANGUAGE sql` inlining nor the policy's own `(SELECT …)` wrapper blocks it (D96), so
  doctor's `provolatile='s'` pin is load-bearing. **(2)** At this corpus size the planner never uses
  the HNSW index: it BitmapAnds `idx_chunks_ws` with `idx_chunks_acl` and sorts exactly, so D58's
  truncation is **latent, not absent** — forcing the plan with `enable_sort=off` gives the small
  tenant **0 rows** under `iterative_scan=off` and all 16 under `relaxed_order`. `extract/index.ts`'s semaphore can also
  over-grant under burst (`acquire()` increments after awaiting, `release()` decrements before
  waking) — reachable only if an `await` is ever introduced between them.
- **Cross-model dissent.** Codex's token is revoked (`codex login status` / `codex exec` both report
  authenticated; a real call still 401s). **Five** passes now, single-model — the M4 review tried
  again and hit the same wall, and M5a's six-specialist review (42 findings, all fixed in `a9d43f1`)
  did not attempt it at all. Every pass since Pass 2 has substituted a fresh-context adversarial
  agent plus a red-team gap hunt — independence of *context*, not of *model*, and it has been enough
  to catch real defects each time, but it is not the same guarantee.
- **`docs/plan.md`** beyond its gate-resolution section — still the only definition of M4 and of
  M5's *phases*. M5's **surfaces** are now defined by `docs/screens.md` (added `8fc0be4`, extended in
  M5a): routes, screens, primary actions and reachable states, including the M5b split. Read both;
  neither covers M6+.
- **Out-of-diff code**, deliberately declined as re-derivation: `src/auth/{google,membership,
  normalize,blocklist,log,routes}.ts` and `src/api/{envelope,reqid,roles,tool-defs,call}.ts`
  (~740 lines, 0 changed in M3, all with test files). `session.ts` *was* read — refresh columns
  confirmed **inert**, backing D34.
- **Whether the shared Supabase project is safe to keep sharing.** Pass 2 established that it drifts
  (§10). It did not establish a policy, a second project, or a reset procedure. (`migrate:reset`
  itself is NOT the hazard here — `migrate.ts:742` gates on `isDevEnv`, which requires an EXPLICIT
  `NODE_ENV` of development/test (`config.ts:128-129`), and `--yes-destroy` plus
  `CB_CONFIRM_RESET=<supabase-project-ref>` stand behind it. The exposure is the ordinary
  shared-database one: dev, the eval harness and CI's `live` job all write the same project.)

---

## 10. Observed, not derived (last full measurement 2026-07-30 at `0b614ef`; partially re-measured 2026-08-01 at `a9d43f1`)

Timestamped observations, not durable properties. **This section decays; the rest of the file does
not.** Re-run before trusting it if the SHAs in the header have moved.

### Stale — last measured 2026-07-30 on `master` at `0b614ef`, BEFORE M5a. `master` is now `a9d43f1`,
six commits and ~3,200 changed lines later (`src/api/server.ts`, `src/index.ts`,
`src/ingest/lifecycle.ts`, `src/auth/csrf.ts`, `src/web.ts`, all of `web/`). §0's re-derive trigger
has fired. Treat every row below as historical and re-run before quoting any of it.

Re-run directly on `master` after the fast-forward, not just trusted from the branch — a clean merge
still isn't a correct one until the ladder confirms it (§1's own lesson).

| Command | Result |
|---|---|
| `bun run typecheck` | **clean** |
| offline suite (DB + provider env blanked) | **506 pass / 183 skip / 0 fail**, ~6.8s — **509 pass** with `web/dist` built, because `test/web-mount.test.ts:32` gates three assertions on the build existing and `dist/` is gitignored. Run `bun install` first: M5a added `compression`, and a stale `node_modules` fails the whole suite. |
| `bun run migrate` (re-run) | nothing re-applied — **idempotent** |
| `bun run doctor` | **73/73** |
| `CB_REQUIRE_LIVE_TESTS=1 bun run test` | **not re-measured since M5a** — the 2026-07-30 figure was 576 pass / 17 skip / 0 fail at `0b614ef`, and M5a added four test files and extended three more. Re-run before quoting. |
| `CB_REQUIRE_LIVE_TESTS=1 CB_RUN_PERF_TESTS=1 bun run test` | **659 pass / 1 skip / 0 fail** (measured 2026-08-01 at `a9d43f1`; was 586/1 at `0b614ef`) |
| empty-acl insert as owner, post-`0012` | **23514 check_violation** — §6.5 genuinely enforced now |
| `select count(*) from pg_index where not indisvalid` | **0** |
| PostgreSQL | **17.6** · pgvector **0.8.2** · `hnsw.ef_search` **40** |

The 17 skips in the perf-unset row are `test/perf-recall.test.ts` and its hooks; with
`CB_RUN_PERF_TESTS=1` they run and the count drops back to the single pre-existing skip below. That
pair of rows *is* the D93 property: the perf suite is invisible to the flag CI sets, and visible to
its own.

The single skip is `test/router.test.ts`'s `describe.skipIf(!!config.CHAT_MODEL)` — gated on model
config, not on database liveness, so it is not a live-gate violation.

### Historical — the pre-merge ladder, kept because it explains how things got here

The first live run in this project's history (2026-07-30, before reconciliation) found: master's
`doctor` at **43/46 and failing**, because the shared database was already in M3's state — someone
had run M3's migrate earlier, so the "one-way door" of applying it was already open. The three
failures were `expected-grants`, `expected-column-grants` and `expected-policies`;
`expected-definers` passed because `current_grants()` is `STABLE` with no `SECURITY DEFINER`, so
master's `prosecdef` filter never saw it. All resolved by the merge, which regenerated
`expected-policies` from the live database.

`HANDOVER.md` line 6's `523 pass / 1 skip` and `doctor 62/62` were confirmed **exactly right** on the
M3 branch before the merge — three passes of arithmetic finally matching an observation.

Green doctor *after* migrate is itself the real idempotency test: `grantExisting` re-broadens every
table on every run, and `narrowGrants` correctly re-narrows it.

**Two documentation defects proven by running them:**

1. **`docs/auth-setup.md:341` documents a command that fails.** It says `CB_REQUIRE_LIVE_TESTS=1 bun
   test`, which bypasses the npm script's `--timeout 30000` and falls back to Bun's 5s default; the
   RLS `WITH CHECK` test then times out. `HANDOVER.md:230`'s `bun run test` is the correct form.
2. **The "offline" verify loop was never offline.** `.env` is a real file at the repo root and is
   symlinked into some worktrees; Bun auto-loads it from cwd, so `hasDbEnv()` sees a populated
   `DATABASE_URL` and every live suite runs against the shared project with real provider calls.
   Anyone who ran the "safe" command has been spending money and seeding rows. **This is still true**
   — the genuinely offline form (env vars blanked on the command line) is in §0.

**One non-defect, recorded so nobody chases it:** the offline run reports a higher TOTAL test count
than the live run (689 vs ~660 at `a9d43f1`). Bun counts `beforeAll`/`afterAll` as skipped entries when their
`describe` is skipped, and the offline run skips far more describes. Not a coverage difference.
