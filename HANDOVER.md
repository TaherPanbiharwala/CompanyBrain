# Handover

**This file is rewritten at the end of each session it makes sense to hand off from — it is a
snapshot, not a running log.** If you are reading an old copy (check the branch/commit line below
against `git log -1 origin/master`), the current one supersedes it entirely; do not merge the two by
hand. `CONTEXT.md` §8 records specific corrections made to *earlier* versions of this file, kept
because those facts about the code are still true even though that version's text is gone.

**New this session: read `AGENTS.md` first if you haven't.** It's the short cross-tool entry point
(D107) — this file, `CONTEXT.md`, and `DECISIONS.md` are what it points you at, in the order that
actually gets you oriented fastest.

**Branch/commit at write time:** `master` @ `a1e390a`, pushed there directly (no second PR — see §2).
**Read `git fetch origin && git log -1 origin/master` before doing anything** — this repo has hit the
same "a concurrent session merged past this exact point and nobody noticed" failure mode on multiple
occasions (`CONTEXT.md` §1's fourth lesson). Do not trust a local ref you haven't just re-fetched.

---

## 0. Two things that look like regressions and aren't — check these before you chase either

**The DB connectivity fault named by the previous two handovers is still resolved.** Nobody touched the
credential or the Supabase project this session either; `bun run doctor`, `bun run migrate`, and the test
suite all ran against the shared project with no connection errors. Still "confirmed-fixed, cause
unconfirmed" — if it comes back, check `.env` and the project reference fresh rather than assuming it's
the same root cause as before.

**New: some sandboxed environments cannot read `~/Desktop/Datasets/MultiHopRAG`.** `ls` on that directory
returns `EPERM: operation not permitted` — an OS-level permission wall (macOS TCC / Desktop-folder
protection on whatever process is running the tools), not anything wrong with the repo or the dataset.
This breaks two things: `bun run load:eval` (can't reload the corpus) and `test/eval-harness.test.ts`'s
"MultiHop adapter, against the real files" suite (10 tests, all failing with the identical `EPERM` stack
trace bottoming out in `readJsonArray` — `src/eval/adapters/multihop.ts:103`). **This is why the full
suite may show `730 pass / 19 skip / 10 fail` instead of the `740 pass / 0 fail` reported earlier in this
same session** — that earlier count was inherited from a pre-compaction summary rather than freshly
re-verified, and the discrepancy was never reconciled; treat `740/0` as unconfirmed and the `EPERM`-caused
`730/19/10` as what was actually, directly observed this session. If you hit this: check `ls
~/Desktop/Datasets/MultiHopRAG` first, before assuming any code change broke something. Fix is either
granting the running process Desktop/Full-Disk access, or re-downloading the dataset somewhere readable
and pointing `--dir` / `MULTIHOP_DIR` at it (see `AGENTS.md` / the script's own `--help`).

`bun run doctor` is **82/82** as of this session, verified freshly (up from the 81 the last handover
named — the increment happened somewhere in the findings-4-10 fix batches between then and now; D106's
own migration is comment-only and added no check itself). Don't re-derive which exact commit added the
82nd check; it isn't load-bearing, and doctor.ts's checks run inside loops, so a source-line count won't
match the runtime total anyway.

---

## 1. What's true right now, verified this session

```
bun run typecheck                          clean
bun run build:web                          not re-run this session; no reason to expect drift
bun run migrate (repeated)                 idempotent, applies 0014-0019 cleanly
bun run doctor                             82/82
bun run test (full suite)                  730 pass / 19 skip / 10 fail — all 10 the SAME §0 EPERM,
                                            not a code regression (see §0 before re-deriving this)
bun run explain:search --since/--until/--author
                                            now genuinely exercises the filtered query shape (D105's
                                            finding #4 fix); read D106 before trusting or re-litigating
                                            what it shows about idx_chunks_ws_effdate
```

---

## 2. What happened since the last handover, in one paragraph each

Full reasoning for every claim below is in `DECISIONS.md` (append-only, D0–D107) and `CONTEXT.md` (the
living snapshot, **not updated this session** — see the note near the end of this section).

**All ten findings from M6's adversarial review (D105) are now fixed — the previous handover's "three
fixed, seven open" is stale.** The seven left open at that point (UTF-16-vs-bytes size cap,
un-normalized `author` filter, `explain-search.ts` unable to exercise a filtered query, duplicated
provenance-derivation logic, duplicated SQL predicate across three `hybridQuery` arms, `soft_delete_*`
hand-copying `current_grants()`'s parsing, and `load-eval-corpus.ts` never wiring dataset metadata into
ingest) were fixed in two follow-up commits, each independently typechecked, doctor'd, and full-suite
tested before landing. `ReportFindings` was re-called after each batch with `outcome: fixed`, so the
review's own record — not just this prose — reflects that all 10 are closed.

**D106 — the one thing D105 deliberately left as a *question* rather than a finding — is now answered
by measurement, not left to rot as an "unverified" comment forever.** `idx_chunks_ws_effdate` (0015) is
proven correct exactly where `since`/`until`/`author` filters are normally narrow relative to a
workspace: a highly selective filter produces a genuine `Index Cond`. At broad (~1/6+) selectivity the
planner skips it — reproduced with a synthetic, in-transaction-only date spread (rolled back, never
persisted; the loaded eval corpus itself still has zero date variance, see below) because the loaded
corpus can't yet produce that middle case on its own. That skip is 0013's already-documented
workspace_id/acl cardinality misestimation recurring for a new column, not a new defect, and Postgres's
extended statistics don't cover the array-overlap operator that would need correcting — so there's no
cheap fix, and the decision (0019, comment-only) is to keep the index as shipped and stop chasing it
further unless a real workspace's own numbers disagree.

**The eval corpus's provenance is still synthetic, not real — that's a live gap for whoever picks up
retrieval-quality work next.** `provenanceFor()` (the findings-8-10 fix) is wired correctly end-to-end —
verified by direct execution against four hand-built cases — but the *currently loaded* 2,829 chunks in
`multihop eval (plain/meta)` all predate that fix and still carry one identical upload-time
`effective_date` and no `author` at all. A reload would fix this but is blocked by §0's `~/Desktop`
permission wall in this environment; it may not be blocked in yours.

**`master` was fast-forwarded directly to this branch's tip, not merged through a second PR.** PR #4
already covered and merged the first commit on this branch (`744ae60`); the five commits after it (three
review-fix batches, the HANDOVER/D105 rewrite, and D106) sat unmerged on the branch until this session
pushed `claude/review-handover-decisions-context-9f5d31:master` directly. `git merge-base
--is-ancestor origin/master <branch>` confirmed master had not diverged, so this was a true fast-forward
with zero conflict risk — worth knowing if you're wondering why there's no second merge commit for this
work.

**`AGENTS.md` is new (D107)** — a short cross-tool entry point (Codex, per D103, and any other agent
that reads it by convention), pointing at this file, `CONTEXT.md`, and `DECISIONS.md` rather than
duplicating them.

**`CONTEXT.md` was not touched this session** (same as last time). Given two sessions' worth of changes
have now landed since it was last checked, treat its specifics as more likely stale than usual, not less.

**Everything from before that wasn't touched is presumed still accurate**: the leak canary (D102, still
zero steps executed), Codex's status (D103 — auth works, dual-voice review still blocked on CLI/model
version), and the two founder rulings in D104 (spend accounting at M8, team scope out of v0).

---

## 3. Working in this repo — for either agent

**Start at `AGENTS.md`, not here, if this is your first time in this repo.** This section is the parts
of that orientation worth restating with more context.

**The three documents that matter are append-only vs. living vs. snapshot, and mixing up which is which
causes real damage:**

- **`DECISIONS.md` is append-only.** Never edit a past entry's reasoning — fix it *forward* with a new
  entry and a one-line pointer in the old one. **Next available number: D108.** This numbering has
  collided across concurrent sessions more than once — **fetch `origin` and check `DECISIONS.md`'s
  actual tail on `origin/master`** before allocating a number, merge if it's moved, only then append.
- **`CONTEXT.md` is a living snapshot**, corrected in place, not appended to. **Not updated for two
  sessions running now** (M6 and this one) — treat any specific number or line-citation in it as a claim
  to re-verify, more so than usual.
- **`docs/m5b.md` has its own refresh methodology**, untouched this session; M6 (and this session's
  follow-ups) are `docs/pipeline-roadmap.md` territory, not M5b's.
- **This file gets rewritten, not appended to.**

**Two conventions worth carrying into any process, regardless of which agent is running it:**

- **Break a guard on purpose before trusting it, or measure instead of reasoning about whether something
  could occur.** M6's own RLS design was live-reproduced wrong (a real `42501`), not theorized wrong; D106
  answered "does the new index actually get used" the same way, with `EXPLAIN`, not by re-reading the
  migration's comment and deciding it sounded plausible.
- **An adversarial review pass is worth running on any RLS/security-relevant change before it merges, not
  just at milestone boundaries.** M6's review found three real, live-reproducible bugs (and seven smaller
  ones, all now fixed) that a normal review and a passing test suite had already missed.

---

## 4. Commands

```bash
bun run typecheck                        # clean
bun run migrate && bun run migrate       # idempotent; doctor.ts:9's own stated precondition
bun run doctor                           # 82/82 as of this session
bun run test                             # 730 pass / 19 skip / 10 fail here — §0 before you trust
                                          # either that count or the 740/0 figure from earlier
bun run explain:search --since <date> --until <date> --author "<name>"
                                          # exercises the filtered query shape; D106 has the verified
                                          # verdict on what you should expect to see
bun run eval:rag --dataset multihop      # docs/eval-rag.md has the full flag surface. Remember: the
                                          # loaded corpus's provenance is still synthetic (see §2)
```

`.env` at the repo root is a **symlink to the main worktree's file**, shared across every worktree. It
is gitignored. Never copy over it, never print it. (If a worktree is missing it entirely rather than
having it as a broken symlink, that's just because nobody created the symlink there yet — `ln -s
/path/to/main-worktree/.env .env` fixes it; this happened at least once this session.)

---

## 5. Where to pick up

**M6's adversarial review (D105) is fully closed — all 10 findings fixed, the one open question (D106)
answered.** There is no remaining findings list from that review; don't go looking for one.

**The most concrete near-term item is §0's `~/Desktop` permission wall**, if you're in an environment
that hits it: it blocks reloading the eval corpus with real provenance, which in turn blocks ever
observing `idx_chunks_ws_effdate` at realistic (not synthetic, not degenerate) selectivity, and blocks
10 tests in `test/eval-harness.test.ts`. Either grant the running process Desktop access, or get the
MultiHop dataset onto a path it can read and point `MULTIHOP_DIR` there.

**Unchanged from the last two handovers, still not in scope for any recent session:**

1. **The leak canary has never run on a CI runner.** D102's six-step sequence is still fully unexecuted.
   `docs/ci-setup.md` has the secret checklist.
2. **Codex** — auth works (D103), dual-voice review still blocked on `codex-cli` rejecting every model
   tried. A CLI upgrade is the plausible next step, deliberately not attempted without a founder ask.
3. The two founder rulings in D104 (spend accounting stays at M8, team scope stays out of v0) — settled,
   not action items, carried forward for context only.

**`docs/pipeline-roadmap.md`'s M7 (retrieval intelligence) still has its stated dependency satisfied** —
`effective_date` exists and, per D106, its supporting index behaves correctly where it's meant to. M7 is
a reasonable next milestone if the founder wants to keep going in that direction, but the roadmap itself
says this competes with M5b for the same weeks — still the founder's call, not this document's.
