# Handover

This is a snapshot, not a running log. Read `AGENTS.md` first, then fetch origin before trusting the
branch line below.

**Branch/commit at write time:** `codex/session-summary-next-steps-784f80` at `be63188`. M8 (the cycle
engine) is committed at `6eb8aa8`, on top of `origin/master` `457a7ea`; M9 (link extraction, wave 1)
is committed on top at `be63188`. The post-review M9 hardening, including applied forward migration
`0022_link_security_hardening.sql`, remains an uncommitted working-tree diff. Nothing is pushed or
merged. See "Milestone 9" below for the completed evidence gate and exact non-promotion result.

## Current outcome (M7)

Milestone 7's gbrain retrieval-intelligence port is implemented behind the baseline default. The
behavioral source is pinned to upstream commit `8c70f6255047a7647adb30b1d6333a48068d9fa5` and covered
by the repo's existing MIT attribution. The five-intent classifier, intent-specific effective RRF k,
exact matching, optional recency, immutable policy resolver/hash, one-statement SQL integration,
held-out MultiHop sweep, and strict NovaByte comparator are built.

**Production ranking has not been promoted, and now has two measured reasons why.**
`DEFAULT_RETRIEVAL_KNOBS` still aliases `BASELINE_RETRIEVAL_KNOBS`; recency is off. The original
eight-profile M7 run (D110) and the later nine-profile run including M9 graph expansion (D113) both
failed their preregistered holdout gates. The latest run's tuning winner, `gbrain-intent`, improved
holdout recall@8 by 0.44pp but had Bonferroni-adjusted p=1. Per the rule — a failed or unrun gate means
baseline stays selected — this is the correct final outcome, not an open promotion blocker. NovaByte
was not run because either failed retrieval gate independently vetoes promotion.

## What changed

- `src/search/query-intent.ts`, `recency-decay.ts`, and `retrieval-knobs.ts` own the pure M7 policy.
  The resolver order is code default → reserved workspace insertion point → strict
  `CB_RETRIEVAL_KNOBS_JSON` → trusted internal call override. Public HTTP/MCP schemas are unchanged.
- `src/search/hybrid.ts` now reads one policy object. It keeps embedding and reranking outside
  `withScopedTx` and applies intent-aware fusion, exact match, recency, adjusted duplicate selection,
  and final limiting inside one SQL statement. The dynamic shortlist fully rescales every admitted
  arm candidate under the validated 400-candidate ceiling.
- `src/search/rrf.ts` has a backward-compatible additive helper for a distinct k per list.
- `answerQuestion` accepts internal-only policy/clock overrides so NovaByte exercises the exact answer
  pipeline. Search/ask clients cannot set them.
- `src/eval/core.ts`, `src/eval/retrieval-sweep.ts`, and `scripts/run-retrieval-sweep.ts` implement the
  seed-42 joint stratified split, nine registered profiles, immutable checkpoint contract, tuning
  selection, untouched holdout, 10,000-sample paired bootstrap, Bonferroni gate, latency/error/degrade
  gates, and reports at k 4/8/12/16/20.
- `scripts/novabyte-eval.ts` separates setup from evaluation, labels policy outputs, fingerprints the
  actual loaded corpus, and reuses it. `compare:novabyte` is the strict regression gate.
  `compare:a17-top8` is the correctly named A17 comparator; `score:top8` remains an alias.
- D110, `CONTEXT.md`, `docs/pipeline-roadmap.md`, `docs/eval-rag.md`, and `.env.example` record the
  implementation and the non-promotion boundary.

## Fresh validation on this diff

```text
bun run typecheck                                      clean
bun run test                                           812 pass / 17 intentional skip / 0 fail
bun run doctor                                         82/82
CB_RUN_PERF_TESTS=1 bun test test/perf-recall.test.ts  10 pass / 0 fail
git diff --check                                       clean
```

The complete suite used the valid seeded eval identity below because the repo's `.env` MCP pair is
stale. The first sandboxed attempt could not resolve the database host; the escalated rerun above is
the authoritative result.

The live SQL-versus-TypeScript equivalence check and expanded hybrid integration coverage pass,
including baseline equivalence, exact/recency promotion, adjusted duplicate survivor selection,
filters on every arm, keyword-only degradation, cross-tenant isolation, and a 200-candidate case past
the old fixed 100-row boundary. A local-vector `explain:search` on the small singletopic workspace
kept the lateral `offset 0` hydration fence; PostgreSQL chose an exact tenant index plus sort at that
size. Doctor confirms the stored FTS GIN and vector HNSW indexes exist. The real MultiHop plan was
inspected after corpus load as part of the sweep sequence below; see the holdout-gate result in
`DECISIONS.md` D110 rather than re-deriving it here.

**Re-verification in a later, separate sandbox could not reproduce the DB-touching half of this.**
`bun run typecheck` was still clean and every M7-specific test file (`query-intent`, `retrieval-knobs`,
`rrf-intent`, `recency-decay`, `retrieval-sweep`, `novabyte-compare`, `ragtest-adapter`) still passed
with no DB involved. But `bun run doctor` and all 52 DB-touching tests failed there with `tenant/user
postgres.gyscmykxazysahsbokll not found` (ENOTFOUND) — every one of the 52 failures was in a
pre-existing suite (`M2 auth`, `RLS smoke`, `hybridSearch — live`, etc.), none in a new M7 file, so this
does not look like a regression from this work. It matches this repo's recurring, previously
"confirmed-fixed, cause unconfirmed" DB connectivity fault (see older `HANDOVER.md` history via
`git log`). Treat the `doctor 82/82` and live-hybridSearch results above as unverified-in-that-later-
environment rather than contradicted; re-check Supabase project status / `.env` freshness before
trusting either number again from a new sandbox.

## Seeded evaluation state

The approved non-production database has DB-only MultiHop identities/workspaces. The corpus has since
been loaded and swept (see above) — this section originally listed the identities pre-load:

```text
principal       944063a3-03dc-4e3d-8ccc-5cbe2b41391a
plain workspace e8694551-127b-48a1-b543-1e0b889bef06
meta workspace  16936155-9348-4664-8a64-aea6a8587459
```

State is in ignored `eval/.eval-workspaces.json`. Both local datasets are readable.

## What happened after data-egress approval, and where M7 actually landed

The sequence below (steps 1-6, as originally planned) ran to completion once data-egress approval was
granted; this section originally described it as a future plan and is rewritten now that it is history.

1-3. `dump:top8 --check`, `load:eval --dataset multihop`, and `explain:search` all ran; no cross-tenant
   HNSW/planner drift was found, and the real MultiHop plan matched the pre-load expectation (stored
   FTS/GIN, vector HNSW where the planner chooses it, bounded lateral hydration).
4. `bun run eval:sweep --dataset multihop --variant plain` first ran the preregistered eight-config
   M7 sweep (D110). The M9 review added its preregistered ninth graph profile, then ran the complete
   nine-profile sweep `2026-09-19T19-11-33-790Z-be63188-m7` (D113). Both holdout gates failed; the
   latest artifact is `eval/runs/multihop-2026-09-19T19-11-33-790Z-be63188-m7.sweep.md`. Nothing was
   tuned on holdout and no winner was hand-selected.
5. NovaByte setup/comparison (step 5) was **not run** — the holdout gate already failed on its own,
   which already forces step 6's "otherwise retain baseline" branch regardless of what NovaByte would
   say. Re-run it only if a future sweep attempt's holdout gate actually passes.
6. Gate did not pass, so `DEFAULT_RETRIEVAL_KNOBS` was correctly **not** changed. It still resolves to
   `BASELINE_RETRIEVAL_KNOBS`.

**If picking this back up to try for a passing gate:** the loaded MultiHop corpus still carries the
synthetic, upload-time-only `effective_date`/no-`author` limitation D106 already documented — recency
tuning is working against degenerate metadata, which plausibly caps what `recency-auto-only` and the
`-recency-on`/`-strong` profiles could ever show. A reload with real per-article provenance (blocked
previously by a `~/Desktop` sandbox permission wall, per older `HANDOVER.md` history — may not be
blocked in every environment) would be the highest-leverage next attempt before assuming the intent
table itself is the wrong idea.

~~Per `docs/pipeline-roadmap.md`'s own recommendation, M9 (link extraction/backlinks, written as a
plain script rather than building M8's cycle engine) is the other reasonable next step and does not
depend on this gate passing.~~ **Superseded — see "Milestone 8" below.** The founder was shown this
exact tradeoff (the roadmap argues M8 only pays for itself once several phases share it) and chose
to build M8 now anyway, ahead of M9. D111 records the decision. M9 (link/fact extraction) remains
the natural next milestone to actually exercise the cycle engine, but is not started.

## Milestone 8 — the cycle engine

**Current outcome.** M8 (`docs/pipeline-roadmap.md`) is implemented: phase runner + base class
(`src/core/cycle.ts`, `src/core/cycle/base-phase.ts`), workspace-scoped row-based lock with
same-host dead-holder reap (`src/core/cycle/lock.ts`), a fail-closed transactional budget ledger
wired into `src/ai/router.ts`'s `chat()`/`embed()` (`src/core/cycle/budget-meter.ts`),
checkpoint/resume (`src/core/cycle/checkpoint.ts`), an ordinary run-history audit log
(`src/core/cycle/ingest-log.ts`), and a failure ledger (`src/core/cycle/failure-ledger.ts`). The
no-op phase (`src/core/cycle/phases/noop.ts`) exercises all of it. New migration
`src/db/migrations/0020_cycle_engine.sql` adds the five backing tables, RLS-enabled, workspace-scoped.
The CLI (`scripts/run-cycle.ts`, `bun run cycle`) and the repo's first scheduled workflow
(`.github/workflows/cycle.yml`, hourly, `workflow_dispatch` also available) run it. D111 has the full
design rationale, including why this diverges from gbrain twice (row lock over advisory lock;
budget ledger fails closed, transactional, not JSONL/best-effort).

**A `/review` pass on this diff found and fixed 3 real bugs that would have broken the exit
criterion entirely** — worth reading before anything below, since it's exactly the kind of thing
"typecheck + offline tests are clean" cannot catch:
1. `noop.ts` called `checkBudget({ modelId: 'noop', ... })`, but `'noop'` was never added to
   `PLACEHOLDER_PRICING_USD_PER_MILLION` — every single run would have thrown
   `UnknownModelPricingError` on tick 1, forever, including the first scheduled cron run after merge.
2. `BudgetMeter.check()`/`.record()` threw `BudgetExhaustedError` from *inside* the same
   `withScopedTx` transaction that had just inserted the audit row — which rolls the insert back too
   (standard SQL transaction semantics), so the `allowed:false` row the ledger's whole design exists
   to preserve was never actually committed. Fixed by moving the throw to after the transaction
   resolves.
3. `check()`'s "prior spent" sum only counted `actual_cost_usd` (NULL until `record()` runs), so
   multiple `check()` calls in a row before any `record()` could each independently pass even though
   their combined estimate exceeded the cap. Fixed by coalescing to `estimated_cost_usd` for
   still-pending rows (and, as a consequence, a failed provider call now resolves its ledger row as
   $0 in a `try/catch` in `router.ts` rather than leaving it permanently pending).
See D111 and the code comments at each fix site for the full reasoning. All three were caught by an
adversarial-review subagent reading the code fresh, not by any test — a reminder that "the offline
suite is green" and "this code is correct" are different claims when the only suites that exercise
the real code path (not a stub) are the live ones that have not run yet (below).

**Verification status — fully live-verified, migration applied.** After the review above, this was
run for real against the shared Supabase project (`DATABASE_URL`/`DATABASE_ADMIN_URL` sourced from
the main checkout's `.env`, which this worktree doesn't carry its own copy of):

```text
bun run typecheck                                         clean
bun run test (offline)                                    681 pass / 242 skip / 0 fail
bun run migrate                                            applied 0020_cycle_engine.sql cleanly
bun run doctor                                             82/82 after `--update` (fixture diff
                                                             reviewed: 5 new workspace-equality RLS
                                                             policies, cb_app-only grants, zero
                                                             cb_auth exposure, nothing else touched)
test/cycle.live.test.ts (CB_REQUIRE_LIVE_TESTS=1)           20/20 pass
test/cycle-kill9.live.test.ts (the actual exit criterion)   1/1 pass
test/hybrid.test.ts (regression check on router.ts)         18/18 pass, unaffected
```

**Two more real bugs surfaced only by actually hitting the database** — confirming the review's own
point that offline-clean and correct are different claims:

4. `saveCheckpoint()`/`writeIngestLog()` wrote jsonb columns via
   `${JSON.stringify(value)}::jsonb` — postgres.js infers a jsonb parameter from the `::jsonb` cast
   and JSON-encodes whatever it's handed, so a pre-stringified value gets encoded a **second** time:
   the column ends up holding a jsonb *string* whose content is the array/object's JSON text, not a
   jsonb array/object. `op_checkpoints`'s own `completed_keys_array` CHECK constraint caught this
   immediately on the very first live run. Fixed by passing the value directly
   (`${completedKeys}::jsonb`, `tx.json(entry.details)`) — never pre-stringify for a `postgres`
   tagged-template jsonb slot.
5. The dead-holder reap (`HOLDER_TAKEOVER_GRACE_MS`) and the TTL/steal-grace fallback both have a
   **hardcoded 60-second floor** before a crashed lock becomes reclaimable, regardless of how short a
   TTL it was given — confirmed live when the kill-9 test's first version retried within seconds and
   reliably got `skipped (cycle_already_running)` back. This isn't a bug so much as a previously
   undocumented, now-proven characteristic: crash recovery is never faster than ~60s, which matters
   for anyone tuning the lock TTL expecting sub-minute recovery. Restored gbrain's own
   `GBRAIN_LOCK_STEAL_GRACE_SECONDS` escape hatch as `CB_CYCLE_LOCK_STEAL_GRACE_SECONDS` (dropped
   during the original port) so the kill-9 test can actually exercise reclaim in ~15s instead of
   waiting out the real floor.

Test coverage also grew during review, independent of the DB run: RLS cross-tenant isolation tests
for `cycle_budget_ledger` and `cycle_failures` (previously only `cycle_locks`/`op_checkpoints` had
one), a regression test for bug 3, `runCycle`'s ok/partial/failed status-aggregation logic
(previously only ever exercised via the always-succeeds noop phase), and chat()/embed()
budget-denial and failed-call-resolution tests in `test/router.test.ts`.

**Not yet done, deliberately out of scope for this change:** M9 itself (the cycle engine has no
phase to run beyond the proof-of-concept no-op); wiring `scripts/purge-deleted.ts` into the new
schedule (still run by hand); verifying `PLACEHOLDER_PRICING_USD_PER_MILLION` in `budget-meter.ts`
against a live provider response (only matters once a real phase calls `chat()`/`embed()` with a
budget scope — the noop phase never does); tuning the cron cadence and lock TTL defaults (both
placeholders — see D111); the disclosed-not-fixed design gaps from the review (budget cap doesn't
survive a crash/restart since `run_id` is fresh each time; no fencing token if a heartbeat fails
silently; the sequential per-workspace CLI loop has no fairness mechanism as tenant count grows) —
all inert for the current noop-only scope, all worth a second look before a real M9+ phase leans on
this.

**Before merging this to master, know what it activates:** `.github/workflows/cycle.yml` is a real
`schedule:` trigger. Once this reaches `master`, GitHub Actions will start running `bun run cycle
--phase noop` hourly against the one shared Supabase project — the same one `ci.yml`'s `live` job
uses — indefinitely, using existing `DATABASE_URL`/`DATABASE_ADMIN_URL` repo secrets. That is a
standing recurring job, not a one-time action; confirm the cadence and target project are actually
wanted before pushing to master, not just the code.

## Milestone 9 — link extraction, wave 1

**Current outcome.** M9's stated exit criterion is complete: backlinks populate on ingest, and the
link-aware graph variant ran through the M7 harness rather than being assumed valuable. The measured
result is **no promotion**. Fact extraction was explicitly deferred by the founder because it is
absent from the milestone's exit criterion and needs a separately designed data model; see D112.

**What shipped:** `0021_link_extraction.sql` creates directional page edges with two endpoint ACLs;
the pure, zero-LLM markdown/title/slug extractor runs synchronously on ingest and in the registered
`link_extraction` cycle phase for backfill and backward-mention discovery. Graph expansion is a
fifth, default-off retrieval arm. Its candidates have a separate bounded reservation so it cannot
displace the base arms, and reciprocal edges are deduplicated before per-seed caps.

**Review hardening (D113, migration `0022_link_security_hardening.sql`):** each edge now carries
denormalized endpoint deletion state, and a SECURITY DEFINER trigger canonicalizes endpoint ACL,
workspace, and deletion fields on every link write while propagating a page ACL/delete change to
incoming and outgoing edges. Empty ACL arrays are rejected with `cardinality`, direct link UPDATE is
revoked, and the cycle's sentinel gets only bounded, workspace-bound SECURITY DEFINER apertures.
Reconciliation serializes under a single workspace advisory-lock protocol without reciprocal target
row locks; the cycle streams source bodies in 200-page batches, caps definer arrays at 1,000 ids and
inserts at 5,000 rows. It is crash-resumable and no longer holds an entire workspace's bodies or
one transaction per page in memory. Title masking is UTF-16 safe; link caps and graph order are
deterministic.

**Verification.** `0022` applied cleanly to the shared Supabase project. `bun run typecheck`,
`git diff --check`, and the full offline suite passed (713 pass / 268 intentional skip / 0 fail).
`bun run doctor` is 104/104 after a manually reviewed fixture update. The affected live suites pass:
the complete M9 group (51 checks across link security, reconciliation concurrency, batch extraction,
file ingest, hybrid graph behavior, and lifecycle), plus `cycle.live.test.ts` + the cross-tenant
`leak-canary.test.ts` (53/53). The actual 609-page / 2,829-chunk MultiHop plan was inspected with
graph enabled: hydration stayed indexed and bounded; the sparse current link graph (two edges) made
the links scan appropriately tiny.

**Completed nine-profile sweep.** Run `2026-09-19T19-11-33-790Z-be63188-m7` used the immutable seed-42
70/30 split (1,579 tuning / 676 holdout), 10,000 bootstrap resamples, and the predeclared 12-member
holdout family. `gbrain-intent` won tuning at 39.01% all-evidence recall@8 versus baseline 38.76%;
`graph-expansion-only` scored 38.68% (and had two tuning errors, so was ineligible). On untouched
holdout, `gbrain-intent` gained 0.44 percentage points (3 fixed, 0 broken) with a 95% CI of
0.00–1.33 points, raw p=0.102 and Bonferroni-adjusted p=1. The only failed gate was statistical
significance; holdout p95 latency improved from 2,362 ms to 1,969 ms and had zero errors/degradations.
The runner's exit 1 is therefore intentional. `DEFAULT_RETRIEVAL_KNOBS` remains the baseline and
`graphExpansion.enabled` remains false. Full artifact: `eval/runs/multihop-2026-09-19T19-11-33-790Z-be63188-m7.sweep.md`.

**Remaining, deliberately not claimed solved:** fact extraction; real-customer quality measurement
of title/slug mentions; and the wave-1 extractor's CPU O(P²) candidate matching on a very large
workspace. These are future scope, not open correctness, tenancy, or promotion-gate defects.

## Working-tree cautions

The untracked `.claude/` directory and `docs/enterprise-learning-roadmap.md` predate this work and
belong to the user; they were not edited. `0020` (M8) and `0021` (original M9) are committed and
applied; review-hardening migration `0022` is applied to the shared project but remains uncommitted
alongside its source/test/docs changes. A fresh clone or another worktree must run `bun run migrate`
to apply them. Keep the transaction handle literally named `tx`, and never weaken the RLS boundary.
