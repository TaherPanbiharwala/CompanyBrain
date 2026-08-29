# Handover

**This file is rewritten at the end of each session it makes sense to hand off from — it is a
snapshot, not a running log.** If you are reading an old copy (check the branch/commit line below
against `git log -1 origin/master`), the current one supersedes it entirely; do not merge the two by
hand. `CONTEXT.md` §8 records specific corrections made to *earlier* versions of this file, kept
because those facts about the code are still true even though that version's text is gone.

**Branch/commit at write time:** `master` @ `d7a955c` (M6 metadata plane, PR #4, plus a same-day
adversarial-review fix commit — both described in full below). **Read `git fetch origin && git log -1
origin/master` before doing anything** — this repo has hit the same "a concurrent session merged past
this exact point and nobody noticed" failure mode on at least three separate occasions now (`CONTEXT.md`
§1's fourth lesson, and it happened again mid-session this time: this session's own branch was cut
before a separate same-day commit landed D104 on `master`, discovered only by re-fetching before
allocating the next `DECISIONS.md` number). Do not trust a local ref you haven't just re-fetched.

---

## 0. The database fault from the last two handovers is resolved

**§0 of the prior two versions of this file named a total DB-connectivity fault** (every command
opening a Postgres connection failing with `tenant/user ... not found` against the shared `.env`,
first surfaced 2026-08-09). **This session confirmed it is gone** — `bun run doctor`, `bun run migrate`
(twice), the full test suite, and a live 2,255-question retrieval eval all ran successfully against the
shared project throughout this session, with no connection errors at any point. Nobody in this session
touched the credential or the Supabase project directly, so treat this as **confirmed-fixed, cause
unconfirmed** — plausibly the founder-side credential rotation `docs/m5b.md` §4.1 named as the likely
explanation, but that hasn't been independently verified, only the *symptom's* absence has. If a future
session hits the same error again, don't assume it's the same root cause without checking `.env` and
the project reference fresh — a lot can happen to a shared credential over two weeks.

`bun run doctor` is now **81 checks**, up from 73 at the last full count — the growth is M6's own
(3 new checks for the soft-delete RLS shape, plus the new columns/policies moving the fixture-diffed
counts). Don't quote 73 from memory anywhere in this repo going forward; that count is now stale.

---

## 1. What's true right now, verified this session

```
bun run typecheck                          clean
bun run build:web                          not re-run this session; no reason to expect drift
bun run migrate (twice)                    idempotent, applies 0014-0018 cleanly
bun run doctor                             81/81
bun run test (full suite)                  737 pass / 0 fail / 19 skip, across 55 files
bun run eval:rag --dataset multihop        2,255 questions x 2 workspaces, 0 errored — twice
                                            (once against the untouched pre-M6 corpus, once against
                                            a fully rebuilt one; see §2's M6 paragraph for what each
                                            run does and doesn't prove)
```

---

## 2. What happened since the last handover, in one paragraph each

Full reasoning for every claim below is in `DECISIONS.md` (append-only, D0–D105) and `CONTEXT.md` (the
living snapshot, **not updated this session** — see the note at the end of this section). This section
exists so you don't have to read either cover-to-cover just to get oriented; it does not replace them
for anything you're about to act on.

**M6 — the metadata plane — shipped, was adversarially reviewed, and three real gaps were fixed
same-day (D105).** `effective_date`/`author`/`metadata`/`content_hash` on `pages`, denormalized onto
`content_chunks`, `since`/`until`/`author` search filters, and soft delete for `delete_page`/
`delete_pages`. The soft-delete RLS design took two migrations to get right: the first attempt
(`0014`, a single `FOR ALL` policy with `deleted_at IS NULL` folded into its own `USING` clause) was
live-measured to fail — Postgres does not let an `UPDATE`'s new-row check diverge from what `SELECT`
requires of the same row, whatever the policy's own `WITH CHECK` text says, so the soft-delete write
itself 42501'd. `0016` fixed it with the textbook-correct shape: a separate `RESTRICTIVE`,
`FOR SELECT`-only policy plus two `SECURITY DEFINER` functions that write as the owner. An 8-angle
adversarial review (finder pass + independent verification; all 10 candidates confirmed) then found
three things that design still missed — `page_sources` (the original uploaded file bytes) never got
the same soft-delete treatment and stayed fully readable indefinitely; the pre-existing slug/file-hash
unique indexes never excluded soft-deleted rows, so deleting a page permanently squatted its own slug;
and a batch delete aborted its *entire* transaction on one benign concurrent-edit race instead of
reporting just that row as refused. All three are fixed (migrations `0017`/`0018` plus a `lifecycle.ts`
change). **Seven further confirmed findings were left open on purpose** — read D105 for the full list
(a UTF-16-vs-bytes size-cap bug, an un-normalized `author` filter, some code duplication, and a real
gap in `explain-search.ts`'s own verification capability for the new index) rather than re-deriving it
by re-running the review.

**Retrieval was re-tested twice, and the two runs prove different things — know which is which before
citing either.** The first run, against the *untouched* pre-M6 corpus, isolated causation properly:
`hit@1`/`candidate-recall` matched the existing D100 baseline exactly, and the two mechanisms that
could plausibly have caused drift (the new search filters, the new RLS clause) were each directly ruled
out rather than assumed clean. The second run, after fully wiping and rebuilding the corpus from
scratch, showed a larger but still non-regressive shift — useful for "does retrieval still work on a
fresh index," useless for "did M6 change anything," since it no longer holds corpus state constant.
Don't cite the second run as a regression check; it isn't one.

**`CONTEXT.md` was not touched this session.** Given the scale of M6, its §2 (system overview), §3
(where things live — the ingest/search modules gained real behavior, not just new files), and §5
(open work — the M7 roadmap dependency on `effective_date` is now satisfied) are all likely stale in
places. The next session that does real work in `src/ingest/`, `src/search/`, or `src/db/` should
expect to find and fix a few specific staleness points there rather than assume it's still current —
this file and `DECISIONS.md` are the two documents actually kept current this session.

**Everything from the prior handover that this session did not touch is presumed still accurate**:
the leak canary status (D102's six steps, still zero executed as of this writing — nobody has published
the repo, stood up a separate CI Supabase project, or set the ten secrets), Codex's status (D103 — auth
works, dual-voice review still blocked on CLI/model-catalog version), and the two founder rulings from
D104 (spend accounting at M8, team scope out of v0). None of these were re-verified this session; they
simply weren't in scope for M6 work.

---

## 3. Working in this repo — for either agent

**This project will be worked on by both Claude Code and Codex sessions going forward.** Nothing below
assumes one or the other; where something *is* tool-specific, it says so.

**The two documents that matter are append-only vs. living, and mixing up which is which causes real
damage:**

- **`DECISIONS.md` is append-only.** Never edit a past entry's reasoning — if it turns out wrong, fix
  it *forward*: add a new entry and put a one-line pointer in the old one. `CONTEXT.md` §7 is a whole
  section of entries that *didn't* get a forward pointer when they should have, and the cost of
  following one to a dead end is a wasted afternoon. **Next available number: D106.**
  **This has now collided at least twice**, most recently this session: this session's branch was cut
  from a point before a separate, same-day commit added `D104` on `master`. The fix each time has been
  the same — `git fetch origin` and re-check `DECISIONS.md`'s actual current tail on `origin/master`
  (not your local checkout) before allocating a number, merge that in first if it's moved, and only
  then append. Skipping the fetch is exactly how this keeps happening.
- **`CONTEXT.md` is a living snapshot**, meant to be corrected and re-derived in place, not appended
  to. It was **not updated this session** (see §2's note above) — treat every specific number or
  line-citation in it as a claim to re-verify against current code, more so than usual, since a full
  milestone's worth of ingest/search changes landed since it was last checked.
- **`docs/m5b.md` has its own refresh methodology** (its own §8): six parallel area audits, each
  followed by an adversarial pass whose only job is to refute "missing" findings. Not touched this
  session either, and M6 doesn't change its scope (M6 is `docs/pipeline-roadmap.md` territory, not
  M5b's).
- **This file (`HANDOVER.md`) gets rewritten, not appended to.**

**Two conventions worth carrying into any process, regardless of which agent is running it:**

- **Break a guard on purpose before trusting it.** M4's review (D97) found seven guards that passed
  with their subject deleted. This session's own review process did the equivalent for M6's RLS design
  — a live-reproduced `42501`, not a hypothetical, is what actually found the `0014` design was wrong,
  and a direct side-by-side SQL comparison (not just re-running the eval) is what ruled out the
  `deleted_at` clause as the source of the retrieval drift. Prefer measuring the actual failure over
  reasoning about whether one could occur.
- **An adversarial review pass is worth running on any RLS/security-relevant change before it merges,
  not just at milestone boundaries.** M6's review found three real, live-reproducible-shaped bugs that
  a normal review (and a passing test suite) had already missed — the migration's own extensive header
  comments and the new doctor checks did not catch any of the three, because all three were gaps in
  what those checks were checking, not violations of what they already checked.

---

## 4. Commands

```bash
bun run typecheck                        # clean
bun run migrate && bun run migrate       # idempotent; doctor.ts:9's own stated precondition
bun run doctor                           # 81/81 as of this session
bun run test                             # full suite: 737 pass / 0 fail / 19 skip
bun run explain:search                   # see D105's open-findings list: this cannot currently
                                          # exercise a since/until/author-filtered query — hardcodes
                                          # them to null. Fix that before trusting migration 0015's
                                          # new index on a filtered query shape.
bun run eval:rag --dataset multihop      # the RAG harness; docs/eval-rag.md has the full flag surface
```

`.env` at the repo root is a **symlink to the main worktree's file**, shared across every worktree. It
is gitignored. Never copy over it, never print it.

---

## 5. Where to pick up

**The two founder-decision items from the last handover are unchanged — neither was in scope this
session:**

1. **The leak canary has never run on a CI runner.** `D102`'s six-step sequence (agreed 2026-08-09) is
   still fully unexecuted — repo still private, zero secrets configured, no separate CI Supabase
   project. `docs/ci-setup.md` has the secret checklist.
2. **Codex** — auth works (confirmed 2026-08-24, `D103`), dual-voice review is still blocked on the
   installed `codex-cli` rejecting every model tried. A CLI upgrade is the plausible next step,
   deliberately not attempted without a founder ask.

**What M6's adversarial review left open (D105) is the most concrete near-term work**, roughly ordered
by how much it matters:

1. `scripts/explain-search.ts` cannot exercise a `since`/`until`/`author`-filtered query — fix that
   *before* trusting migration `0015`'s new index (`idx_chunks_ws_effdate`) at any real corpus scale.
   This repo has direct, expensive precedent (`0013`) for a correlated predicate silently losing its
   index and nobody noticing for a while.
2. The `metadata` field's "10KB" cap measures the wrong unit (UTF-16 length, not UTF-8 bytes) — a small
   fix in `src/api/operations.ts`.
3. The `author` search filter has no normalization, unlike this codebase's own established pattern for
   other exact-match identity fields.
4. `scripts/load-eval-corpus.ts` doesn't wire `EvalDocument.metadata`'s `author`/`published_at` into
   the new ingest fields — until it does, the MultiHop corpus can't actually exercise the new
   `since`/`until`/`author` filters, which matters if anyone wants to validate them the way D100
   validated `MAX_PER_PAGE`.
5. Two smaller reuse/duplication findings (provenance-derivation logic copy-pasted across three ingest
   files; the same SQL predicate block copy-pasted across three `hybridQuery` arms) and one
   security-hygiene one (the new `SECURITY DEFINER` functions hand-copy `current_grants()`'s parsing
   logic instead of calling it) — all in D105, none urgent, all cheap once picked up.

**`docs/pipeline-roadmap.md`'s M7 (retrieval intelligence) now has its stated dependency satisfied** —
`effective_date` exists. The roadmap's own sizing put M6+M7+M9 as the highest-value-per-week slice of
the whole M6-M14 map; M7 is a reasonable next milestone if the founder wants to keep going in that
direction, but `docs/pipeline-roadmap.md` itself is explicit that this competes with M5b for the same
weeks, and that tradeoff is still the founder's to make, not this document's.
