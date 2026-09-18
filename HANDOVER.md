# Handover

This is a snapshot, not a running log. Read `AGENTS.md` first, then fetch origin before trusting the
branch line below.

**Branch/commit at write time:** `codex/intent_classifier`, based on freshly fetched
`origin/master` `297c8cacc93c4ced7a7eaae09221f63d066f3cec`. M7 is committed on this branch (`git log -1`
for the exact SHA) and merged to `master` in the same session this line was last edited.

## Current outcome

Milestone 7's gbrain retrieval-intelligence port is implemented behind the baseline default. The
behavioral source is pinned to upstream commit `8c70f6255047a7647adb30b1d6333a48068d9fa5` and covered
by the repo's existing MIT attribution. The five-intent classifier, intent-specific effective RRF k,
exact matching, optional recency, immutable policy resolver/hash, one-statement SQL integration,
held-out MultiHop sweep, and strict NovaByte comparator are built.

**Production ranking has not been promoted, and now has a measured reason why.**
`DEFAULT_RETRIEVAL_KNOBS` still aliases `BASELINE_RETRIEVAL_KNOBS`; recency is off. The preregistered
MultiHop holdout sweep (blocked on data-egress approval when this section was first written) has since
run to completion and its promotion gate **failed**: see D110 and `eval/multihop-m7-latest.md`. The
tuning-split nominal winner (`gbrain-fusion-only`) did not reach significance on the untouched holdout
(Bonferroni-adjusted p=1). Per this milestone's own rule — a failed or unrun gate means baseline stays
selected — that is the correct, final outcome of this sweep attempt, not an open blocker. NovaByte was
not run; the holdout gate already vetoed promotion on its own.

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
  seed-42 joint stratified split, eight registered profiles, immutable checkpoint contract, tuning
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
4. `bun run eval:sweep --dataset multihop --variant plain` ran the full preregistered 8-config sweep.
   Full results: `eval/multihop-m7-latest.md` / `.json`. **The holdout gate failed** — see D110 for the
   numbers. Nothing was tuned on holdout and no winner was hand-selected; the artifact stands as run.
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
table itself is the wrong idea. Per `docs/pipeline-roadmap.md`'s own recommendation, M9 (link
extraction/backlinks, written as a plain script rather than building M8's cycle engine) is the other
reasonable next step and does not depend on this gate passing.

## Working-tree cautions

The untracked `.claude/` directory and `docs/enterprise-learning-roadmap.md` predate this work and
belong to the user; they were not edited. No migration was added or changed. Keep the transaction
handle literally named `tx`, and never weaken the RLS boundary while resolving evaluation issues.
