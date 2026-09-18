# Agents working in this repo

**Read this file first, then follow its pointers before making any change.** It orients any AI coding
agent — Claude Code, Codex, or otherwise — landing here without prior context (D103 named Codex as
expected back in this repo's workflow, and there was no single file that told a fresh agent where to
start). It is deliberately short: an index into the documents below, not a copy of them.

## Read in this order

1. **`HANDOVER.md`** — a snapshot of exactly where things stood as of the session that last wrote it,
   and what to do next. Rewritten each session, not appended to. Check its branch/commit line against
   `git fetch origin && git log -1 origin/master` before trusting it — this repo has repeatedly hit the
   failure mode of a stale local ref (`CONTEXT.md` §1).
2. **`CONTEXT.md`** — the living technical reference: system overview, where things live, known gotchas.
   Corrected in place, not appended to. More detail than `HANDOVER.md`; not necessarily as current — its
   own header says when it was last touched, and not every session updates it.
3. **`DECISIONS.md`** — the append-only decision log, D0 onward. Every non-obvious choice in this repo
   has an entry here explaining *why*, not just what. Never edit a past entry's reasoning; if it turns
   out wrong, fix forward with a new entry and a one-line pointer back. **Fetch `origin/master` before
   allocating the next number** — concurrent sessions have collided on this more than once.
4. **`README.md`** — local setup only.

## Hard rules, because getting them wrong has cost real time here

- **Migrations are forward-only.** `src/db/migrations/NNNN_*.sql` files are checksummed once applied —
  never edit one after the fact; fix forward with a new file. `schema.sql` is the immutable baseline.
- **RLS is the tenancy boundary, not an app-level check.** Every content-table query must run inside
  `withScopedTx`, through a transaction handle literally named `tx` — `test/scoped-tx-guard.test.ts`
  enforces this by reading the source for that name, not just checking behavior.
- **`bun run doctor` is the security-posture gate.** If it isn't green after a change touching auth,
  RLS, or grants, the change isn't done. Its fixture-diffed checks (`test/fixtures/expected-*.json`) get
  reviewed by hand after `--update`, as a security change — never rubber-stamped.
- **Don't trust a claim about the query planner — run `bun run explain:search` and read the actual
  plan.** This repo has paid for that lesson twice now (`0013`, `D106`): a correlated predicate silently
  losing its index is invisible in code review and in a passing test suite alike.
- **`bun run typecheck` and the full `bun run test` suite clean before calling anything done — and
  neither one is sufficient on its own.** M8 and M9 each shipped bugs that typecheck and the full
  offline suite passed on, caught only by actually applying the migration and running the live suite
  against a real database (D111, D112). Offline-clean and correct are different claims here; say so
  explicitly rather than treating a green offline run as "verified."
- **Never write a jsonb column via `${JSON.stringify(value)}::jsonb`.** `postgres` (the npm package)
  infers a jsonb parameter from the `::jsonb` cast and JSON-encodes whatever JS value it's handed for
  that slot — a pre-stringified value gets encoded a SECOND time, landing as a jsonb *string*
  containing the value's JSON text, not the array/object itself. Pass the value directly
  (`${arr}::jsonb`), or `tx.json(obj)` for an object needing a type assertion past
  `Record<string, unknown>`. Bit twice in one milestone before this rule existed (D111).
- **A live-DB test asserting an RLS property MUST run through a scoped connection
  (`withScopedTx`/`buildContext`), never `adminSql()`.** The admin/owner pool is BYPASSRLS by design,
  so a test written against it can pass even when the RLS policy it claims to prove is broken or
  missing — a false-positive test, not a weak one. Caught live in D112's own soft-delete test.

## Environment-specific gotcha, current as of D106

Some sandboxed environments cannot read `~/Desktop/Datasets/MultiHopRAG` (`EPERM` — an OS-level
permission wall, not a repo bug). `bun run load:eval` and `test/eval-harness.test.ts`'s "against the real
files" suite both need that path. See `HANDOVER.md` for current status before assuming a failure there
is a regression.
