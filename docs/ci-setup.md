# Configuring CI — the ten repo secrets the `live` job needs

`DECISIONS.md` D16 calls the leak canary sacred: "runs in CI forever, never skipped to move faster."
Until these secrets exist that is a claim about infrastructure rather than a description of it — the
`live` job in `.github/workflows/ci.yml` has never executed a single test. Every master run dies at
step 5, *Apply migrations*, with:

```
error: DATABASE_ADMIN_URL is not set (Supabase `postgres` connection). See .env.example.
```

That is `src/db/migrate.ts:610`. Steps 6 (`doctor`) and 7 (the live suites) then skip, so the
cross-tenant canary — the test that proves per-row ACL isolation, this product's main enterprise
guarantee — has never once run in CI.

This file is the checklist for fixing that. It contains **value shapes only, never values.**

---

## Before the secrets: two things that must be true first

Setting all ten correctly does nothing unless both of these hold. Check them in this order.

### 1. GitHub must actually schedule the job

Observed on run `31125506724`, both jobs of the same run:

```
typecheck + offline suite      success    runner="GitHub Actions 1000000083"
live isolation suite (canary)  cancelled  runner=""     15m2s, 0 steps executed
```

The `live` job never acquired a runner. Separately, a master push produced **no workflow run at all**
(`gh api .../actions/runs?head_sha=<sha>` → `total_count: 0`) despite `on: push: branches: ['**']`.
Actions were enabled and the workflow `active` throughout.

On a private repo this is almost always an exhausted Actions balance or a `$0` spending limit
(Settings → Billing → Actions). Public repos get unmetered minutes, so publishing the repo resolves
it. If minutes are healthy and it persists, the discriminator is that `offline` schedules and `live`
does not — look at the job-level concurrency group at `ci.yml:83-85`.

**The signal that it is fixed is a `live` job reporting a non-empty `runner_name`,** not a green
check:

```bash
gh run view "$(gh run list --workflow CI --limit 1 --json databaseId -q '.[0].databaseId')" --json jobs \
  -q '.jobs[] | "\(.name)  runner=\"\(.runner_name // "")\""'
```

### 2. Use a CI-only Supabase project, not the shared one

`ci.yml:71-77` already says this is the real fix, and it is a precondition rather than a follow-up.
The `live` job runs `bun run migrate` with **owner** credentials — DDL, role-password `ALTER`s, and
`CREATE INDEX CONCURRENTLY`. Pointing that at the project you develop and demo on means:

- every master push mutates your working database;
- a run cancelled mid-suite leaves canary rows behind (`test/leak-canary.test.ts` cleans up in
  `afterAll`), and a mid-run cancellation is exactly what has already happened;
- `ci.yml:80` permits `workflow_dispatch` on **any ref**, and the workflow definition that receives
  these secrets is whatever *that ref's* `ci.yml` says. Dispatching against an existing ref needs no
  push. With a throwaway CI project the blast radius of that is a scratch database; with the shared
  project it is production.

Create a second free-tier project, then against it:

```bash
bun run migrate && bun run migrate && bun run doctor
```

**Twice on `migrate`** — `src/db/doctor.ts:9` documents the idempotency check that needs the second
run. Then `bun run seed:a17` to create the membership row the `mcp` suite requires (see #7/#8).

---

## The ten secrets

All ten are **repository** secrets (Settings → Secrets and variables → Actions → Repository secrets).
Not environment secrets — neither job in `ci.yml` declares an `environment:`, so environment secrets
would not resolve.

| # | Secret | Value shape | Where it comes from |
|---|---|---|---|
| 1 | `DATABASE_URL` | `postgres://cb_app.<ci-ref>:<app-pw>@aws-0-<region>.pooler.supabase.com:6543/postgres` | CI project → Settings → Database → **Transaction** pooler (port 6543). Replace the username with `cb_app.<ci-ref>` and the password with #4. |
| 2 | `DATABASE_ADMIN_URL` | `postgres://postgres.<ci-ref>:<db-pw>@aws-0-<region>.pooler.supabase.com:5432/postgres` | Same page, **Session** pooler (port 5432), username `postgres.<ci-ref>`, the project's own database password. |
| 3 | `DATABASE_AUTH_URL` | as #1 but `cb_auth.<ci-ref>` | Transaction pooler again; password is #5. |
| 4 | `CB_APP_DB_PASSWORD` | random, your choice | Must byte-match the password embedded in #1. See the trap below. |
| 5 | `CB_AUTH_DB_PASSWORD` | random, your choice | Must byte-match the password embedded in #3. |
| 6 | `SESSION_SECRET` | ≥ 32 chars | Generate fresh for CI; do not reuse the Railway one.<br>`bun -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"` |
| 7 | `CB_MCP_PRINCIPAL` | uuid | `bun run seed:a17` **against the CI project**. It prints these as `CB_CLI_PRINCIPAL` / `CB_CLI_WORKSPACE` — same UUIDs, different variable names (`scripts/seed-a17.ts:34-35`). |
| 8 | `CB_MCP_WORKSPACE` | uuid | Same command, second line. |
| 9 | `OPENAI_API_KEY` | any non-empty placeholder | Never actually used — see below. |
| 10 | `OPENROUTER_API_KEY` | any non-empty placeholder | Same. |

### Do not use the direct database host

`db.<ref>.supabase.co` is IPv6-only without the paid IPv4 add-on and will not resolve from a GitHub
runner. Both pooler hostnames above are IPv4 and are the only forms that work in CI. This is the same
reason `.env.example:18-20` says so for local use on IPv4-only networks.

### The password-matching trap

`bun run migrate` does not merely *read* #4 and #5 — it **assigns** them to the `cb_app` and `cb_auth`
roles (`src/db/migrate.ts:203`, inside a `DO` block). Since D63 that write is conditional on
`passwordAlreadyCorrect` (`:180-183`), so a password that already matches is never rewritten.

The failure mode when they disagree is nasty because the first step still passes:

1. *Apply migrations* connects as `postgres` using #2, so it succeeds.
2. While succeeding, it sets the `cb_app` role's password to #4.
3. #1 still embeds the *old* password, so every step after that fails to authenticate.

Build each URL by substituting the password variable in, never by typing it twice. Same relationship
between #5 and #3.

### Why #9 and #10 are placeholders

Every live suite overwrites the key on the config object and installs `installFakeAiFetch`
(`test/helpers/fake-ai.ts`) before making a call — `test/leak-canary.test.ts:53-54`,
`answer.test.ts:29-30`, `ingest.test.ts:28`, `hybrid.test.ts:48`, `scope-acl.test.ts:73`,
`ingest-file.test.ts:46`, and both `lifecycle*` suites. That fake **throws** on any URL it does not
recognise, so an accidental real provider call fails loudly rather than billing silently.

Placeholders therefore make CI structurally unable to spend money. Real keys would also work; they
would just be spendable credentials sitting in CI for no benefit. Embedding quality is validated by
`bun run eval:a17` against the real provider, never by these structural tests.

`CHAT_MODEL` is deliberately **not** a CI secret. It has no code default (`src/config.ts`), and
`test/router.test.ts` has a block gated on `!!config.CHAT_MODEL` that consequently runs only in CI —
where `.env` does not exist — and never on a laptop where it is set.

---

## Setting them

Pipe the value on stdin. Do not use `--body` and do not paste into the web UI:

```bash
printf %s '<value>' | gh secret set DATABASE_URL -R <owner>/<repo>
```

`gh secret set --body "$V"` puts the credential in the process command line, where any local process
can read it via `ps`. The web form puts an owner-level database password into browser history and
autofill. `gh` strips trailing newlines from stdin but **not** trailing spaces, so watch for those.

### `gh secret set` accepts empty input and exits 0

This is the one failure that looks exactly like success. An empty secret is worse than a missing one:

- `src/config.ts` declares these as `z.string().default('')`, so present-but-empty is
  indistinguishable from unset;
- GitHub substitutes a missing secret as the empty string rather than erroring;
- the job then dies at the same `migrate.ts:610` it dies at today;
- and `gh secret list` shows all ten names, so the obvious check passes.

**`gh secret list` showing ten names is not verification.** Run the job.

---

## Verifying

```bash
gh workflow run CI --ref master
```

`workflow_dispatch` is in the `if:` at `ci.yml:80` precisely so the canary can be run on demand
rather than by waiting for a merge. Then confirm it **executed** rather than merely passing:

```bash
RUN=$(gh run list --workflow CI --limit 1 --json databaseId -q '.[0].databaseId')
JOB=$(gh run view "$RUN" --json jobs -q '.jobs[]|select(.name|startswith("live")).databaseId')
gh run view --job "$JOB" --log | grep -c '(pass)'
```

Do **not** grep the log for `skip`. Skips are expected in a correct run: `test/perf-recall.test.ts`
skips by design under D93 (`perfOrFail` returns false unless `CB_RUN_PERF_TESTS` is set), and
`test/router.test.ts` has the `CHAT_MODEL` block noted above. A `skip` match proves nothing either
way. Check that the pass count is non-zero and that `leak-canary` appears among the executed suites.

Under `CB_REQUIRE_LIVE_TESTS=1` — which `ci.yml:123` sets — a live suite that *would* have skipped
throws instead (`test/helpers/live.ts`), so a green `live` job means the canary genuinely ran. That
flag is the whole point of D43, and `test/live-gate.test.ts` enforces mechanically that no suite can
quietly opt out of it.

---

## Related

- `.env.example` — the authoritative shape of every variable, including the ones CI does not set.
- `docs/auth-setup.md` §7 — running the security suites locally.
- `docs/deploy.md` — the Railway deploy, which is a separate variable surface from this one.
