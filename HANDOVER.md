# Handover

**This file is rewritten at the end of each session it makes sense to hand off from — it is a
snapshot, not a running log.** If you are reading an old copy (check the branch/commit line below
against `git log -1 origin/master`), the current one supersedes it entirely; do not merge the two by
hand. `CONTEXT.md` §8 records specific corrections made to the *previous* version of this file, kept
because those facts about the code are still true even though that version's text is gone.

**Branch/commit at write time:** `master` @ `f05cde5`. **Read `git fetch origin && git log -1
origin/master` before doing anything** — a concurrent session merged past this exact point mid-way
through the work described below, and neither session noticed until a manual check (see "Working
across sessions" below). Do not trust a local ref you haven't just re-fetched.

---

## 0. The one thing to check before anything else

**As of 2026-08-09, every command in this repo that opens a Postgres connection fails**, against the
shared `.env`, with:

```
PostgresError: (ENOTFOUND) tenant/user postgres.gyscmykxazysahsbokll not found
```

That's `bun run doctor`, `bun run migrate`, any `CB_REQUIRE_LIVE_TESTS=1` test, `dump:top8`,
`eval:rag`, `eval:novabyte` — all of it, in every worktree, because `.env` is a symlink to one shared
file (`CONTEXT.md` §4) and Bun auto-loads it regardless of what you unset on the command line.
Reproduced twice; not a network blip.

**This is plausibly an in-progress fix, not a fresh bug.** `docs/m5b.md` §4.1 names, as a founder-only
action already agreed 2026-08-09: *"Rotate the Supabase database and both role passwords (a review
subagent leaked connection strings into its own output)."* A rotated or replaced project produces
exactly this error until `.env` is updated to point at it. **Ask before debugging this as a code
problem** — it almost certainly isn't one, and no command in this session's toolkit can fix a
Supabase project reference. Full detail: `CONTEXT.md` §6.14.

Everything else in this file assumes that gets resolved. Until it does, only `typecheck` and
`build:web` are trustworthy signals.

---

## 1. What's true right now, verified this session

```
bun run typecheck                          clean
bun run build:web                          clean (writes web/dist)
bun run test  (DB env unset on cmdline)    585 pass / 17 skip / 50 fail — the 50 are §0's DB fault,
                                            not a code regression; env-unsetting does not achieve a
                                            genuinely offline run because Bun reloads from .env
bun run doctor / migrate / any live test   FAILS on §0 — cannot be trusted, at all, right now
CI (`live` job, GitHub Actions)            RED on every push since the workflow existed, on THREE
                                            independent grounds: 0 secrets configured (dies at
                                            "Apply migrations"); GitHub is not scheduling the job at
                                            all on recent runs (empty runner_name, cancelled at 15m);
                                            repo is private, so even green it can't be a required
                                            check. `offline` job passes. See D102 / docs/ci-setup.md.
repo visibility                            PRIVATE (confirmed via `gh repo view`) — D102 names
                                            publishing it as the fix for two of the three grounds above
```

Do not quote a doctor check count (73? 75?) from memory or from another doc without re-running it —
see `CONTEXT.md` §6.13/§9 for why it's disputed and currently unmeasurable.

---

## 2. What happened since the last handover (M3), in one paragraph each

Full reasoning for every claim below is in `DECISIONS.md` (append-only, D0–D103) and `CONTEXT.md`
(the living snapshot). This section exists so you don't have to read either cover-to-cover just to
get oriented; it does not replace them for anything you're about to act on.

**M4 — enforcement + doctor** shipped, was reviewed seven times, and survived: a perf/scale suite, a
cross-transport rate meter at `dispatchOp` rung 0, and two new doctor checks. Seven of its own guards
were found to pass with their subject *deleted* — the fix pattern (D97) is "break the thing on
purpose and confirm the guard goes red," and it's worth applying to anything you add.

**M5a — the web app** shipped: a Vite+React SPA, CSP+HSTS, ask/upload/pages/invite screens, deployed
to Railway. A six-specialist pre-landing review found 42 issues, all fixed before merge.

**A security finding (D99) closed a real gap.** Supabase's Data API — REST access to every table via
`anon`/`authenticated`/`service_role`, the last with `rolbypassrls = true` — was on by default on the
live project and had never been used or audited by this codebase. Fixed by disabling it at the
dashboard (no code change); the standing rule (disable on every future project, at creation) is D99.
This is very likely the reason for §0's current DB fault — a credential rotation was the first
follow-up action named.

**A RAG eval harness was built and used once, immediately overturning its own first finding.** A
40-question sample said one class of question (needing 4 documents at once) was stuck at 0% recall no
matter how much was retrieved — read at the time as proof no ranking fix could reach it. Running the
full 2,255-question set overturned that: the same bucket climbs to 19% by k=20, just slower than
easier questions. **The lesson, worth internalizing before trusting any small-sample finding in this
repo again:** a flat curve at n=10-40 is not evidence of a structural ceiling. One real change shipped
from the full run — `MAX_PER_PAGE` 3→2 in `src/search/hybrid.ts`, +3.3pp recall, 75 questions fixed
and 0 broken, verified by simulating it offline first and then confirming the simulation matched the
live engine to the decimal. Full reasoning: D100. A separate, real bug in the *other* eval harness
(`novabyte-score.ts` was silently printing regressions as improvements and vice versa) was found and
fixed in the same window — D101 — which is what makes an answer-quality check on retrieval changes
possible for the first time.

**A separate, concurrent session actually root-caused why the leak canary never runs, past the
missing secrets.** GitHub was not even scheduling the `live` job (a run with a real `offline` pass
sitting next to a `live` job that never acquired a runner and got cancelled at 15 minutes — the
exhausted-Actions-minutes signature on a private repo), and the repo being private means it can't
make `live` a required check regardless of secrets, because branch protection needs a paid plan or a
public repo on GitHub's free tier. `docs/ci-setup.md` is the resulting secret checklist (shapes only,
never values); `D102` is the six-step decision — publish the repo, stand up a separate CI Supabase
project first, then set the ten secrets. None of the six steps has been executed yet. The same
session also wrote up where Codex actually stands (`D103`): `codex login status` has said
"authenticated" throughout six review passes while every real call 401s — a false-positive that's
worth knowing before trusting the status check alone.

**A from-scratch audit of what M5b actually needs produced `docs/m5b.md`.** Six parallel area audits,
each followed by a pass whose only job was to find implementations the auditor had missed — six
claims were corrected that way, all in the direction of "more is built than the roadmap says." Read
it before `CONTEXT.md` §5 for scope; it supersedes that section's item-by-item status and corrected
six things `CONTEXT.md` itself had gotten stale on `docs/m5b.md` §7 lists them; the ones re-verified
and folded into `CONTEXT.md` this pass are in its §5.1, §6.10, and the new §6.14/§6.15.

**A gap analysis against gbrain (the MIT reference this repo forked from) produced
`docs/pipeline-roadmap.md`** — nine milestones, M6 through M14, for the ingestion/enrichment work
company-brain hasn't built (link extraction, contextual retrieval, a cycle/enrichment engine, etc.).
It is a map, not a commitment — read its own "What to actually build" section before treating any of
it as scoped work, and note it competes with M5b for the same calendar time.

---

## 3. Working in this repo — for either agent

**This project will be worked on by both Claude Code and Codex sessions going forward.** Nothing
below assumes one or the other; where something *is* tool-specific, it says so.

**The two documents that matter are append-only vs. living, and mixing up which is which causes real
damage:**

- **`DECISIONS.md` is append-only.** Never edit a past entry's reasoning — if it turns out wrong,
  fix it *forward*: add a new entry and put a one-line pointer in the old one ("Closed by D101" /
  "Reversed by D66" — see the pattern used throughout). `CONTEXT.md` §7 is a whole section of
  entries that *didn't* get a forward pointer when they should have, and the cost of following one to
  a dead end is a wasted afternoon. Next available number: **D104**.
  **This is not hypothetical — it happened while this handoff was being written.** A concurrent
  session, in a separate worktree, independently allocated D101 (for an unrelated CI/leak-canary
  decision) and D102 (for a Codex-auth decision) from the same base this session's D101 came from.
  Resolved by merge: this session's D101 kept its number (already committed first), theirs became
  D102/D103, with a footnote at D101 in `DECISIONS.md` recording why. If you're about to allocate a
  decision number, `git fetch origin` first — a stale local view of "the last entry" is exactly how
  this happens.
- **`CONTEXT.md` is a living snapshot**, meant to be corrected and re-derived in place, not appended
  to. It says explicitly at the top which SHA it was last checked against — if `master` has moved
  since, treat every specific number/line-citation as a claim to verify, not a fact to quote.
- **`docs/m5b.md` has its own refresh methodology**, described in its own §8: six parallel area
  audits (by topic, not by file), each followed by an *adversarial* pass whose only job is to refute
  the "missing" findings by locating the implementation the first pass missed. It is expensive to
  produce and cheap to read — that asymmetry is the entire reason it exists as a separate file rather
  than folded into `CONTEXT.md` §5.
- **This file (`HANDOVER.md`) gets rewritten, not appended to**, per the note at the top.

**No Claude-Code-specific tooling is assumed anywhere in this repo's own process.** If a past session
mentions `/autoplan`, `AskUserQuestion`, or a gstack skill, that describes *how a Claude Code session
happened to do its own review* — it is not a repo convention and Codex has no equivalent. Every
verification step that actually matters is a plain command, listed in §4 below, runnable identically
from either tool. Two conventions worth carrying into any process, regardless of which agent is
running it:

- **Break a guard on purpose before trusting it.** M4's own review (D97) found seven guards that
  passed with their subject deleted. If you add a test or a doctor check, verify it goes red when the
  thing it protects is broken — not just green when the thing is fine.
- **Measure before diagnosing, especially on a small sample.** §2's eval-harness paragraph above is
  the concrete example: n=40 said one thing, n=2,255 said another, and the cheap full run was
  available the whole time.

**Working across sessions/worktrees** — the concrete failure mode from this exact handoff, recorded
so it doesn't repeat: two sessions ran in separate worktrees, one merged the other's branch via PR
without the first session knowing, and the first session's local `git log` kept showing its own
branch tip as if it were current. The fix: `git fetch origin && git rev-parse HEAD origin/master` —
comparing against the fetched **remote** ref, not a cached local one — before assuming your starting
point is `master`'s actual tip. Do this at the start of a session and again before any push. Full
account: `CONTEXT.md` §1's fourth lesson.

---

## 4. Commands

```bash
bun run typecheck                        # no DB needed; trust this one right now
bun run build:web                        # no DB needed; trust this one right now
bun run test                             # DB-dependent suites will fail until §0 resolves
```

Once §0 is confirmed resolved:

```bash
bun run migrate && bun run doctor        # doctor must be green; note and report the check count,
                                          # it's a live dispute (CONTEXT.md §6.13/§9)
CB_REQUIRE_LIVE_TESTS=1 bun run test     # a SKIP here is a failure, by design
bun run dump:top8 --check                # retrieval regression guard (A17 corpus — shallow, see D100)
bun run eval:rag --dataset multihop      # the RAG harness; docs/eval-rag.md has the full flag surface
DATASET=~/Desktop/novabyte-test-dataset bun run eval:novabyte   # now scoreable correctly (D101)
```

`.env` at the repo root is a **symlink to the main worktree's file**, shared across every worktree.
It is gitignored. Never copy over it, never print it, and remember that Bun auto-loads it — you
cannot get a genuinely DB-free test run by unsetting variables on the command line (§0).

---

## 5. Where to pick up

**Read `docs/m5b.md` first — do not re-derive "what's left" from `docs/plan.md` or from this
section.** It's a verified register with `file:line` evidence for every item, ranked by whether it
blocks the actual self-serve gate rather than by roadmap prose, and it is far more current than
anything below could be kept.

The two items that most need a **founder** decision, not a coding session, because both were true at
last check and neither has a purely-technical resolution:

1. **The leak canary has never run on a CI runner.** Zero secrets configured, repo still private (so
   even fully configured, GitHub's free tier won't let it gate a merge). `docs/m5b.md` §4.1 has the
   full six-step sequence, already agreed 2026-08-09 but not recorded as a `DECISIONS.md` entry
   anywhere until someone writes it up — do that as part of executing it, not after.
2. **§0's database fault** — needs the founder to confirm whether it's an in-progress rotation or
   something else, before any session spends time on it as a bug.

The single largest **buildable** item, per `docs/m5b.md`: team scope, end-to-end (§2.1 there, sized
XL). The substrate exists and is completely inert — no write path, and a keyring read that needs
either a sixth `SECURITY DEFINER` or a two-phase read (the latter works today with zero new SQL,
`docs/m5b.md` §2.1 has the exact reasoning). Whether it's in scope at all before a design partner asks
for it is itself an open question `docs/m5b.md` §6.1 names explicitly — don't assume it's next just
because it's biggest.

The cheapest real wins, all independently shippable, all named with exact `file:line` in
`docs/m5b.md` §3: a stale line of copy in the upload flow claiming re-scoping isn't possible (it
shipped in `07aee51`); the empty-brain cold-start not switching tabs after a successful upload; no
demo script exists despite being named in `docs/plan.md`; the A17 seed data can't demonstrate the
scope distinction it exists to demonstrate.

**Once §0 resolves and `eval:novabyte` is runnable again (D101 made it trustworthy, nobody has run it
since):** the natural next step for the retrieval work in D100 is running the shipped `MAX_PER_PAGE`
change — and the larger, metric-suspicious `MAX_PER_PAGE = 1` option — through it, since that's the
only gate that can currently tell a real answer-quality improvement from a document-count artifact.
