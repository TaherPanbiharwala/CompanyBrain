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
trust it, with the corrections in §7. `HANDOVER.md` is a per-session artifact, rewritten at the end
of each session it makes sense to hand off from — read the **current** file for where things stand;
it no longer narrates M3 (§8 below is a historical record of corrections made to *that* version,
kept because the underlying facts are still true, not because the M3 text still exists to read
alongside them). `docs/m5b.md` is the current, verified "what's left" register — read it before this
file's own §5 for scope. `README.md` is stale in the ways §5.4 lists. This file is where the repo
actually *is*, and where those get out of sync with the code or each other.

Written against `master` = **`2ac308a`**, then updated for **M4**, then for **M5a**. `master` is now
**`f05cde5`**, **22 commits** past `a9d43f1` (verified by count, not estimated — two independent
passes guessed twelve and fifteen and both were wrong): `07aee51` (ingest hardening), `73e262f`
through `3b76c49` (a Railway Nixpacks/Node-18 deploy outage and its fix), `f33272b` (`DB_SSL`
normalized so a stray value can't silently downgrade TLS), `4bfd891` (the retrieval latency fix —
migration `0013`'s `tsvector` GIN index, which the keyword arm now hard-depends on,
`hybrid.ts:387-401`), `2a4b091` (D99, Supabase's Data API closed as a third RLS-bypassing door), then
**three merged PRs**: a dataset-agnostic RAG eval harness plus one retrieval tuning change
(`1a18803`..`9a7ceb0`, D100/D101, detailed in §6.15), `docs/pipeline-roadmap.md` (M6+ map), and
`docs/m5b.md` (a from-scratch, six-audit verification of every M5b item, with its own adversarial
refutation pass — see §5's banner and §7).

**Two sessions then corrected this file independently, in separate worktrees, from that same point —
and collided.** Both fixed the same drift `docs/m5b.md` §7 had already found (the CI secrets count,
the team-scope overstatements, the novabyte-score fix status); one session additionally investigated
*why* the leak canary was still red past the secrets (GitHub was not scheduling the `live` job at all,
and a private repo can't make it a required check regardless — full write-up now at
`docs/ci-setup.md`, decision at **D102**, with **D103** recording where Codex's auth stands and what
changes once it works — §9); the other found a live database fault blocking all further
re-verification (§6.14) and the reversal in the eval harness's own first finding (§6.15). Both sets of
findings are folded in below. The D101/D102 collision this produced — two sessions allocating decision
numbers from the same base — is the exact hazard §1's fourth lesson (added by the second session)
describes, recurring within the same day it was written down; see the footnote at `DECISIONS.md`
D101 for the renumbering. **Neither session re-ran §10** — one had no live database, the other hit
§6.14's fault — so every row there is now doubly stale; re-run it before quoting anything.

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
bun run doctor                        # must be green — check count disputed (73 vs 75, §6.13/§9);
                                       # AS OF 2026-08-09 this fails outright against the shared .env
                                       # with a tenant-not-found error — see §6.14 before debugging it
                                       # as your own environment's fault
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

**If you do only three things** (down from four — item 3 below closed 2026-08-24, see the note at its
old slot):

0. **Do not trust any live command until you check the database connects.** As of 2026-08-09, `bun
   run doctor` (and therefore `migrate`, any live test, `dump:top8`, `eval:rag`) fails against the
   shared `.env` with `PostgresError: tenant/user postgres.gyscmykxazysahsbokll not found` — the
   Supabase project this credential names does not currently resolve. Full detail, and why this is
   plausibly an *in-progress* fix rather than a regression, at §6.14. Confirm with the founder before
   assuming anything live is broken versus mid-rotation.
1. ~~Vendor `docs/enabling-team-scope.md`~~ — **done in `4ea57d7`.** The spec is now in the repo at
   `docs/enabling-team-scope.md`, with a preface listing six ways it is stale against the current tree
   (`0007` is taken so the real migration is `0013`; touch point 3's keyring read runs before
   `withScopedTx` and silently returns zero rows; touch point 4's `.refine()` breaks module load).
   Read the preface before the body. Team scope itself is deliberately deferred past v0 (D104) — see
   §5.1 for the full scope, kept for whenever it's revisited, not as a queued task.
2. **Make the leak canary actually run, or it stays decorative** (§6.2). ~~Configure the seven repo
   secrets~~ — **the count was wrong and the secrets were never the whole story.** The `live` job
   reads **ten** secrets, not seven (this file had drifted to three different wrong counts across
   three sections before this pass), and `gh secret list` is empty, so every master run dies at
   `Apply migrations` with `DATABASE_ADMIN_URL is not set` — `migrate.ts:610`. The canary has executed
   **zero** tests in CI, ever. **Full write-up, shapes only never values, at `docs/ci-setup.md`** —
   do not re-derive the list by hand again.

   Two things found that outrank the secrets, and that no document here knew about before this pass:
   - **GitHub is not scheduling the job.** Run `31125506724`: `offline` got a real runner and passed;
     `live` got `runner_name=""`, ran zero steps, and was cancelled at 15m2s. A later master push
     produced **no run at all**. On a private repo that is the exhausted-minutes / `$0`-spending-limit
     signature.
   - **The canary cannot gate a merge even fully configured.** `branches/master/protection` returns
     `403 "Upgrade to GitHub Pro or make this repository public"` — required status checks don't
     exist on a private free-tier repo, and `ci.yml:80` is master-push-only anyway. Six consecutive
     master runs have been red since 2026-07-30 and nothing noticed.

   **Decided (D102):** publish the repo (fixes both), stand up a **separate CI Supabase project**
   *before* any secret is set — `ci.yml:80` permits `workflow_dispatch` on any ref, and the shared
   project's owner credential is exactly what should never sit behind that trigger surface — then
   restore `branches: ['**']` and make `live` a required check. D16 becomes literally true at that
   point, not before. The six-step execution sequence is at D102 and independently transcribed at
   `docs/m5b.md` §4.1; none of the six steps has been performed as of this pass.
~~3. Decide where spend accounting lives~~ — **CLOSED 2026-08-24 (D104): M8.** Reverses D18's "by
   M5". M4's rate meter (D94) is unaffected — it was never spend accounting, just a request throttle.
   No ledger/quota work belongs on the v0 path; see §5.3.

Then: the README is stale in five or six ways (§5.4 — re-count it, `a9d43f1` fixed the Status
paragraph and added `build:web` to the quickstart while §5.4 was still listing both as defects, and
§5.4's line numbers all shifted by ~14), and the "readable ≠ publishable" gap (§5.2) is a design
decision waiting on you, not an implementation task.

---

## 1. Repo state — one trunk, and what the fork cost

**`master` at `f05cde5` contains everything.** All branches are ancestors of it (`git branch
--no-merged master` is empty), every worktree is clean, and there are no stashes. `origin` →
`github.com:TaherPanbiharwala/CompanyBrain.git`, and the repo has its first three real **pull
requests** (#1, #2, #3 — the MultiHop eval harness, reviewed and merged through GitHub rather than
fast-forwarded, the first time that has happened in this repo's history). The milestones built: M0,
M1, A17, M2, M3, M4, **M5a**; M5b is unstarted (`docs/m5b.md` is its register). The eval harness is
its own thing, orthogonal to the M-numbers — see the header.

| | |
|---|---|
| ops in `operations.ts` | **14** (`rescope_pages` added; `delete_page` gained a `pageIds` batch arm) |
| migrations | **`0001`–`0013`**; `0008`/`0010` are `.disabled` reverts, **11 applied** |
| `DECISIONS.md` | **104 entries, D0–D103**, no duplicate IDs (verified 0–100 gap-free; D101/D102/D103 added this pass — D102/D103 renumbered on merge from a same-day D101/D102 collision, see the footnote at D101) |
| `doctor` | **73 checks as last measured** — `docs/m5b.md` §7 flags this against `README.md`'s 73/163 lines disputed by nothing, but CONTEXT.md's own §10 says 75; neither has been re-measured live since. One `bun run doctor` settles it. |

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

**A fourth lesson, 2026-08-09/10: two sessions ran concurrently in separate worktrees, and one merged
past the other without either noticing until this pass.** One worktree (`compassionate-cohen-8b3789`)
held the eval-harness branch at its own last-known tip; a second worktree
(`context-review-5957e4`, a different name from its branch — the same mismatch the third lesson
above warns about) was on a *different* branch (`claude/mvp-remaining-work-2c5048`) that had already
merged the first branch via PR, then done a full independent M5b audit, then merged again — three PRs
landed on `master` while the first worktree's session had no way to know. The first worktree's
`git log` still showed its own branch tip as HEAD; only `git fetch origin && git rev-parse HEAD
origin/master` — comparing against the **remote**, not the local ref cache — surfaced the gap.
**The check §0 already prescribes (`git merge-base master HEAD` equals `git rev-parse master`) must be
run against `origin/master` after a fetch, every session, not just once at branch-creation time** —
a long-running session's local `master` ref goes stale the moment any other session pushes, and nothing
signals that locally.

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
| M8 | Spend/usage accounting — not started; **settled 2026-08-24 (D104)**. Was disputed four ways (`docs/plan.md:209` said M8, `docs/plan.md:382`/A15 said M5, D18 said M5, this table said M8 anyway) and had survived two milestones unresolved (`docs/m5b.md` §6). Founder ruling: M8, reversing D18. No ledger/quota work belongs on the v0 path; see §5.3. |

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
src/eval/        core.ts (dataset-agnostic runner) types.ts slug.ts adapters/ (multihop.ts today,
                 index.ts is the registry — a second dataset adapter is the extension point)
src/web.ts       serves the SPA: security headers, static mount, SPA fallback, in-process Vite dev

web/             the M5a frontend (Vite + React 19 + Tailwind 4, same-origin, no CORS anywhere)
  src/           App.tsx (18-line useRoute at :33-50, no react-router) main.tsx index.css (@theme tokens)
    lib/         api.ts (callOp + callAuth, the ONLY fetch layer; DOM-free by test)
    components/  AnswerView.tsx PageList.tsx Upload.tsx ErrorPanel.tsx Invite.tsx
                 ScopeBadge.tsx (the scope label on every hit — shared by AnswerView and PageList)
    screens/     SignIn.tsx CreateWorkspace.tsx AcceptInvite.tsx Home.tsx (Invite is a Home tab, not a route)
  dist/          gitignored; `bun run build:web` writes it and a non-loopback boot REQUIRES it
```

`docs/` — `m5b.md` (the verified remaining-work register, supersedes §5 for scope), `eval-rag.md`
(the MultiHop harness: quick start, cost/time table, why wall-clock not money is the binding
constraint), `pipeline-roadmap.md` (M6–M14), `ci-setup.md` (the ten CI secrets, added this pass),
`screens.md`, `plan.md` (M0–M5b definitions, least reliable of the four on current status), `deploy.md`,
`auth-setup.md`. `scripts/` gained `eval-common.ts`, `seed-eval-workspace.ts`, `load-eval-corpus.ts`,
`run-rag-eval.ts`, `replay-eval.ts` alongside the existing `seed-a17`/`novabyte-*` scripts — two
harnesses, not one, and neither used to be in `README.md` (fixed on master since).

`.github/workflows/ci.yml` — **exists; `HANDOVER.md` never mentions it.** Two jobs: `offline`
(typecheck + `bun run build:web` + unit + the two meta-tests) and `live` (the D16 leak canary,
**master-only** since M5a Phase −1). The `build:web` step is not cosmetic: the SPA-serving
assertions in `test/web-mount.test.ts` are gated on `web/dist` existing, so without it they skipped
on every CI run, silently. **`live` is currently RED on every master push** — reconfirmed
2026-08-10, `gh secret list` is empty and every run since the workflow existed dies at
`Apply migrations` in ~40-45s. It reads **ten** secrets, not seven (`DATABASE_URL` /
`DATABASE_ADMIN_URL` / `DATABASE_AUTH_URL` / `CB_APP_DB_PASSWORD` / `CB_AUTH_DB_PASSWORD` /
`SESSION_SECRET` / `CB_MCP_PRINCIPAL` / `CB_MCP_WORKSPACE` / `OPENAI_API_KEY` /
`OPENROUTER_API_KEY`, grepped directly from `ci.yml`'s `secrets.*` references) — this file had
drifted to three different wrong counts across three sections before this pass; full shapes-only
write-up at `docs/ci-setup.md`, do not re-derive the list here again. `offline` passes.

**The secrets are no longer the binding constraint, though — §0 item 2 and D102 have the full
finding.** The most recent master run never even reached them: `live` got no runner at all
(`runner_name=""`, zero steps, cancelled at 15m2s) while `offline` in the same run passed, and a
later push produced no workflow run whatsoever. And `branches/master/protection` 403s on a private
free-tier repo, so `live` couldn't be a required check even fully green. The D16 "canary runs in CI
forever" guarantee is therefore not real on any of three independent grounds, not one. Bun pinned
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
  §3 and §6.2. The ten names and their shapes are in `docs/ci-setup.md`; do not re-derive them here.
- **Actions is not scheduling the `live` job**, which sits upstream of the secrets — a job that never
  acquires a runner never reads them. Check Settings → Billing → Actions first; the signal that it is
  cleared is a `live` job with a non-empty `runner_name`, not a green check.
- **No CI database.** CI would migrate the one Supabase project that development, the eval harness and
  the demo all share, using owner credentials. §9 has asked for a second project since pass 1; it is
  now a precondition of setting the secrets rather than a follow-up, because `ci.yml:80` accepts
  `workflow_dispatch` on *any* ref and that is where the owner credential would go.

---

## 5. Open work — ranked

> **`docs/m5b.md` (added 2026-08-10, verified at `2a4b091`) supersedes this section for *scope*.** It
> is the full remaining-work register — every M5b item with `file:line` evidence, ranked by whether it
> blocks the M5 gate ("a founder friend self-serves end-to-end") rather than by the roadmap's prose.
> What stays here is the *reasoning* below, which it does not duplicate. Three corrections it makes to
> this section, each verified against the policy fixtures: §5.1's call-site count is **eleven**, not
> ten (it misses `scripts/explain-search.ts:73`); the "sixth `SECURITY DEFINER`" is a design
> preference rather than a hard requirement, because `team_memberships_ws`'s qual carries no
> `current_grants()` term; and the three tables are **not** equally write-blocked — only `acl_grants`
> is `WITH CHECK (false)`, while `teams`/`team_memberships` keep workspace-equality policies and lack
> just the table privilege. Also: §6.2's live CI job reads **ten** secrets, not seven.

### 5.1 Team scope — under-scoped by roughly an order of magnitude, and **not in v0** (D104)

**Settled 2026-08-24: team scope is explicitly out of v0.** `docs/m5b.md` §6.1 posed this as an open
question rather than assume an answer, and the founder's ruling closes it — correct not to build this
speculatively. Everything below stays as a record of the real scope, for whenever it *is* revisited
(design-partner-requested, not before), not as a queued task. The `teams`/`team_memberships`/
`acl_grants` substrate staying dead is now the **intended** state, not an in-progress gap.

`HANDOVER.md` frames it as five touch points with `resolver.ts:122` as "the one most likely to be
missed." Everything below that is missing:

- **No write path.** No op creates a team or assigns a member, and `narrowGrants` (`migrate.ts:337`)
  explicitly revokes `cb_app`'s INSERT/UPDATE/DELETE on all three of `acl_grants` (`migrate.ts:353`),
  `teams` (`:354`) and `team_memberships` (`:355`). A correct keyring would have nothing to read. Only
  `acl_grants_ws` is `WITH CHECK (false)` (`0001_m2_auth.sql:89-92`) — `teams_ws` and
  `team_memberships_ws` were never re-created by `0001` and keep plain workspace-equality
  `WITH CHECK`, so a tenant-confined write to those two tables is already **permitted by RLS**; only
  the table privilege is revoked. That makes the write path exactly the `create_invite` shape, not a
  policy design problem (corrected against `docs/m5b.md` §2.1, which re-verified this from the
  policy fixtures — the two tables are not equally write-blocked, as this section previously said).
- **Chicken-and-egg on the read path, but the fix is a choice, not a hard requirement.** The keyring
  must be built *before* `withScopedTx` opens (grants are GUCs set at transaction start), but
  `acl_grants` is itself RLS-protected on `workspace_id = app.workspace`. A **sixth
  `SECURITY DEFINER`** in `cb_internal` is one answer and preserves the one-DB-call invariant
  (`src/auth/resolver.ts:5-9`). But `team_memberships_ws`'s qual carries no `current_grants()` term
  (confirmed in `test/fixtures/expected-policies.json`), so a two-phase read inside a self+ws-keyring
  `withScopedTx` works **today, with zero new SQL** — cheaper, if the definer's centralization isn't
  needed yet. This section previously called the definer a requirement; `docs/m5b.md` §2.1 corrected
  it to a design preference.
- **Twelve call sites, not ten.** `resolveGrants` is called at `auth/resolver.ts:122`,
  `api/call.ts:37`, `api/mcp.ts:24`, `api/dev-auth.ts:98`, and in eight `scripts/` files —
  `load-a17-corpus.ts:34`, `ingest-file.ts:80`, `novabyte-eval.ts:66`, `measure-a17.ts:65`,
  `run-a17-eval.ts:27`, `dump-top8.ts:47`, `explain-search.ts:73`, and **`eval-common.ts:118`** —
  including the NovaByte and MultiHop harnesses that are supposed to *prove* the fix. Patching only
  `resolver.ts` leaves team pages invisible on CLI, MCP and both eval harnesses. This count has now
  drifted twice in one week: this section said ten, `docs/m5b.md` (verified 2026-08-10) corrected it
  to eleven by finding `explain-search.ts`, and a fresh grep run while writing *this* correction found
  a twelfth — `eval-common.ts`, added by the RAG eval harness (§6.15) after `docs/m5b.md` was written.
  **Re-grep before trusting any number here**; it is not a stable count. The same
  `{src,scripts}/**/*.ts` glob is what `test/acl-tag-format.test.ts:87` scans to enforce that no
  call site smuggles a third argument — its own floor is only `>= 8` (an anti-vacuity check that the
  scanner hasn't gone blind, not a tracked value), so it would not itself notice this count drifting
  further; only a fresh grep does.
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

### 5.3 Rate limiting — **CLOSED at M4**. Spend accounting — **settled at M8** (D104)

~~`apiLimiter` fires only at `server.ts:85`~~ — the per-principal budget now runs at **rung 0 of
`dispatchOp`** (D94), so REST and MCP are metered by one instance and a transport added later is
metered *by omission* rather than by someone remembering. **The CLI is reached but not effectively
metered:** `FixedWindowLimiter`'s buckets are a per-process Map and `call.ts` is one-shot, so a shell
loop starts a fresh bucket every time. Accepted, not fixed — it runs on a developer's own machine
against their own principal, and a shared store belongs with the M8 ledger. The opt-out is an explicit
`DispatchOpts` field taking a reason string, reachable only from in-process TypeScript.
`test/dispatch-limit.test.ts` source-scans `mcp.ts`/`call.ts`/`server.ts` to stop it drifting back to
REST-only. Note `ctx.remote` was considered as the discriminator and **rejected** — it is inverted
(`resolver.ts:123` is `remote:false` for a real browser session), so exempting `!remote` would
unmeter production; don't re-propose it.

**Settled, not open:** this is a rate meter, not a spend cap. No ledger, per-workspace quota or usage
accounting exists anywhere in `src/`, and none belongs before M8 — **D104** (2026-08-24) reverses D18
and settles the milestone dispute `docs/plan.md`, D18 and this file's own table used to disagree on.

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

### 6.2 [closed — gated by `4ea57d7`; live job red, and blocked upstream of its secrets] CI will migrate a shared DB from every branch

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
only, which is pure compute. Live state today: `offline` is green; `live` FAILS because none of the
**ten** secrets it reads were ever added under GitHub Settings → Secrets (the list is in
`docs/ci-setup.md` — this paragraph previously named six of them, §3 named a different seven, and §0
said seven, which is how a re-derivation was needed to get the number right).

**Two things this section did not know, both upstream of the config task.** First, the most recent
master run never got that far: `live` acquired no runner at all (`runner_name=""`, zero steps,
cancelled at 15m2s) while `offline` in the same run ran to green, and a later master push produced no
workflow run whatsoever. Second, `branches/master/protection` returns `403 "Upgrade to GitHub Pro or
make this repository public"` — so even a fully-configured green `live` could not block a merge, and
`:80` keeps it post-merge regardless. So "config task, not a defect" was right about the secrets and
wrong about the outcome: configuring them alone would not have produced a working canary. §0 item 2
records what was decided.

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

### 6.10 [moderate — one item **FIXED** `9a7ceb0`] The NovaByte harness — real defects, mostly latent

Verified against the actual dataset at `~/Desktop/novabyte-test-dataset`. Pass 1's stronger claims
were **refuted**; what survives:

- ~~**LIVE.** `novabyte-score.ts:48-50` inverts UP/DOWN whenever a relevant doc is missing on either
  side, because `findIndex` returns `-1`.~~ — **FIXED `9a7ceb0` (D101).** `-1` now maps to
  worse-than-any-real-rank before the comparison, rather than comparing the raw index. Verified
  against the actual bug: reverting the fix and re-running two synthetic cases (a doc found-then-lost,
  a doc lost-then-found) reproduced the exact inverted `UP`/`DOWN` this bullet describes; the fix
  prints both correctly. This was D100's stated blocker on using `eval:novabyte` as the answer-quality
  gate for a swept retrieval config — the gate is now usable, and as of this writing still unused.
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

**Why `doctor` did not catch this, which is the durable lesson.** Its checks are thorough about
`cb_app`/`cb_auth` — `expected-grants.json` and `expected-column-grants.json` pin their privileges
exactly — but the census only ever asks about the roles this repo creates. A role the *platform*
adds, holding grants the platform issued, is outside every fixture. Worth a check if the Data API is
ever deliberately enabled: assert `anon`/`authenticated` hold no privilege on any `public` table, and
that no role other than `postgres` has `rolbypassrls`. (The exact check count is disputed elsewhere in
this file and in `README.md` — this sentence originally said "75"; do not treat that as authoritative,
see §6.14 for why it could not be re-measured this pass and §9 for the standing dispute.)

### 6.14 [critical, undated fault — surfaced 2026-08-10, unresolved] The shared `.env`'s Supabase project does not currently resolve

`bun run doctor` fails with `PostgresError: (ENOTFOUND) tenant/user postgres.gyscmykxazysahsbokll not
found`, reproduced twice (not a transient blip). Confirmed this is the real, shared credential:
`.env` at the repo root is a symlink to `/Users/taherpanbiharwala/dev/company-brain/.env` (the same
file §4 already documents as shared across worktrees), and Bun auto-loads it — so every worktree, and
every command that opens a Postgres connection, hits this. That includes `migrate`, any live-gated
test, `dump:top8`, `eval:rag`, and `bun run test` even with DB env vars unset on the command line: Bun
repopulates them from `.env` regardless, which is the exact "the offline loop was never really
offline" trap §10 already names — it now applies to a broken connection, not just an unintentionally
live one. Effect measured directly: `bun run test` with `DATABASE_URL` etc. unset in the invoking
shell still produced 585 pass / 17 skip / **50 fail**, all real Postgres connection errors, not
skips.

**Plausibly expected, not a regression** — worth checking with the founder before debugging it as one.
`docs/m5b.md` §4.1's six-step CI-database sequence names, as step 1 and explicitly a founder action:
*"Rotate the Supabase database and both role passwords (a review subagent leaked connection strings
into its own output)."* A rotated or replaced project would produce exactly this error — a
tenant/project reference in the connection string that no longer exists — until `.env` is updated to
point at the new one. This file cannot distinguish "credential rotation in progress" from "the project
was deleted" from any other cause; it can only confirm the failure is real, reproducible, and total.

**Consequence for this pass:** every live number in this file that could otherwise have been
re-verified — the doctor check count (§0, §6.13, §9), the resolveGrants call-site count's live-grep
confirmation (§5.1, grep-based and unaffected), anything in §10 — could not be re-run against a live
database. Typecheck and `build:web` are unaffected (no DB dependency) and were confirmed clean.
`bun run doctor` **must** be run and confirmed green before trusting any of §10 or the doctor-count
rows elsewhere in this file again.

### 6.15 A dataset-agnostic RAG eval harness, and the first retrieval change it produced

Built and merged (`e4ab037`..`9a7ceb0`) in the same window as `docs/m5b.md`. Full detail lives in
`docs/eval-rag.md` and D100/D101 — this is the pointer, not a duplicate.

**What it is.** `src/eval/` (pure scoring, no DB, no network — `slug.ts`, `core.ts`,
`adapters/`) plus `scripts/{seed,load,run}-*.ts`, built behind a `DatasetAdapter` seam so a benchmark
is one file, not a shape threaded through the loader/scorer/report. MultiHop-RAG (2,556 questions,
609 documents) is the first dataset; the internal shape is BEIR-like so a second costs an adapter, not
a rewrite.

**What it found, and the lesson worth carrying forward.** A 40-question sample showed the
4-required-document question bucket flat at 0.0% recall across every k tested, which read as
structural proof that no ranking fix could reach it — two independent plan reviews and the session
that produced them all treated this as settled. Running the **full** 2,255-question set overturned it:
the same bucket climbs to 19.2% by k=20, just slower than the others. The n=40 result was noise from a
low base rate at small sample, not a wall. **The concrete rule this earns:** a flat curve from a
double-digit sample is not evidence of a structural ceiling; run the full set before treating "0% at
every k" as a diagnosis rather than a symptom of n.

**What shipped.** `MAX_PER_PAGE` 3 → 2 in `src/search/hybrid.ts` — the only production code change.
Simulated offline against banked ranked lists, then confirmed live to the decimal at every
question-hop-count, before merging: `all-evidence-recall@8` 36.9% → 40.3%, 75 questions fixed, 0
broken. Full reasoning, including why this shipped *below* the pre-registered 5pp threshold and why
`MAX_PER_PAGE = 1`'s larger +13.8pp is a metric artifact rather than a better answer, is D100. The
`novabyte-score.ts` fix that closes D100's stated blocker is D101 (§6.10 above records the same fix in
its own context).

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

## 8. `HANDOVER.md` — corrections to the M3 version (superseded; kept for provenance)

**`HANDOVER.md` has since been rewritten** to hand off from the current point in the repo, not from
M3 — it is a per-session artifact, not a running log. Everything below refers to the M3-session text
that file used to contain. The corrections themselves remain true statements about the *code* (the
index existed, `worker.ts`'s rebind timing, migration idempotency) regardless of what the current
`HANDOVER.md` says, which is why this section stays rather than being deleted.

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
- **Cross-model dissent — still open, but the diagnosis changed 2026-08-24 (D103's own update, not a
  new entry).** Six passes ran single-model on a `refresh_token_invalidated` 401 through at least
  2026-08-10. **Re-verified this pass and no longer reproduces**: `codex exec` against a real prompt
  now authenticates successfully (checked twice) — the blocker moved to model selection, not auth. The
  installed `codex-cli 0.142.5` rejects the configured default (`gpt-5.6-terra`, "requires a newer
  version of Codex") and rejects every explicit fallback tried (`gpt-5`, `gpt-5-codex`,
  `gpt-5.1-codex`, `codex`, each "not supported when using Codex with a ChatGPT account") — structured
  400s, not 401s. **Still zero successful dual-voice calls**, so this is not yet a working
  cross-model review; a CLI upgrade is the plausible next step and was not attempted here (upgrading
  shared tooling outside an explicit request is a founder call, not a session's to make
  unprompted). D103 has the full detail and is the place to record the outcome once a call actually
  succeeds — update it in place per its own instruction, don't open a new entry. The
  fresh-context-agent substitute (below) stays regardless of how this resolves — it is independent of
  whether Codex works and has caught real defects on its own across every pass since Pass 2.
- **`docs/plan.md`** beyond its gate-resolution section — still the only definition of M4 and of
  M5's *phases*. M5's **surfaces** are now defined by `docs/screens.md` (added `8fc0be4`, extended in
  M5a): routes, screens, primary actions and reachable states, including the M5b split. Read both;
  neither covers M6+. `docs/pipeline-roadmap.md` (added post-M5a) covers M6+: a gbrain-comparative
  gap analysis of the ingestion/enrichment pipeline, milestoned M6–M14. It is a map, not a committed
  plan — M5b is still unstarted and competes with all of it for the same weeks.
- **Out-of-diff code**, deliberately declined as re-derivation: `src/auth/{google,membership,
  normalize,blocklist,log,routes}.ts` and `src/api/{envelope,reqid,roles,tool-defs,call}.ts`
  (~740 lines, 0 changed in M3, all with test files). `session.ts` *was* read — refresh columns
  confirmed **inert**, backing D34.
- **Whether the shared Supabase project is safe to keep sharing — decided, not yet executed.** Pass 2
  established that it drifts (§10) without establishing a policy. **That is now closed as a decision
  (D102, 2026-08-09): a separate CI Supabase project, stood up before any CI secret is set** — a
  precondition, not a follow-up, because `ci.yml:80` accepts `workflow_dispatch` on any ref and an
  owner credential for the shared project is exactly what should never sit behind that. What remains
  is execution: §0 item 2 has the six-step sequence, and none of the six steps has been performed as
  of this pass. `docs/m5b.md` §6 says it the same way — "not open, listed so it is not re-litigated…
  pending execution, not pending a decision." (`migrate:reset` itself is NOT the hazard here —
  `migrate.ts:742` gates on `isDevEnv`, which requires an EXPLICIT `NODE_ENV` of development/test
  (`config.ts:128-129`), and `--yes-destroy` plus `CB_CONFIRM_RESET=<supabase-project-ref>` stand
  behind it. The exposure was always the ordinary shared-database one: dev, both eval harnesses and
  CI's `live` job all writing the same project — and that is what D102 ends.)

---

## 10. Observed, not derived (last full measurement 2026-07-30 at `0b614ef`; partially re-measured 2026-08-01 at `a9d43f1`; NOT re-measured this pass)

Timestamped observations, not durable properties. **This section decays; the rest of the file does
not.** Re-run before trusting it if the SHAs in the header have moved.

**This pass could not re-measure it** — no live database in this worktree (`.env` does not exist
here; it is a symlink to the main checkout in two other worktrees and absent in two, a fact worth
knowing on its own before assuming any worktree has one). Master has moved fifteen commits, a new
migration (`0013`) and a full eval harness since the last row below was captured, so treat literally
every number here as historical until re-run — this is a stronger warning than the last update
carried, because the gap is now larger than at any previous point in this file's history.

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
