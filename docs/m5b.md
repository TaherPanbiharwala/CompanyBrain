# M5b — what remains, verified

Every other document in this repo describes what was *decided* or what was *built*. None of them
answers "what is left" without a reader re-deriving it from four files that disagree. This is that
answer, produced once so it does not have to be produced again.

**Verified against `master` = `2a4b091` on 2026-08-10.** Every status below was confirmed by reading
the code, not by trusting `docs/plan.md`, `CONTEXT.md` or `README.md` — several of which were found
stale in the process (§7). Produced by six parallel area audits, each followed by an adversarial pass
whose job was to *refute* the "missing" claims by finding the implementation the auditor overlooked;
six claims were corrected that way, and those corrections are folded in below rather than appended.

**The standing rule, same as `CONTEXT.md` §10:** this file decays. Line numbers move. Before trusting
an item, spot-check its evidence — every entry carries `file:line` precisely so that costs seconds
rather than an afternoon. When an item is built, delete it from here rather than annotating it.

---

## 0. The distinction the roadmap never noticed

`docs/plan.md` carries two different definitions of "M5 is done" and they do not agree.

- **The text** (`docs/plan.md:192-196`) lists chat with citations, upload with a scope picker,
  `web/admin` with invite + *manual team create/assign* + member list, `memory/conversations.ts`,
  and deploy + seed + demo script.
- **The gate** (`docs/plan.md:235`) is one sentence: *"an external founder completes login → upload
  → invite → ask → cited answer unassisted."*

**Every step of the gate works in code today.** Nothing on that path is missing. The text, meanwhile,
is roughly two thirds unbuilt — and its largest item (teams) is not on the gate path at all.

So "what is remaining" has two honest answers, and which one you want is a founder decision (§6.1),
not a fact about the code. This file is ordered by the gate, not by the text: Tier 0 is the only thing
that can break the gate today, Tier 2 is cheap work that sits directly on it, and Tier 1 is the
roadmap's list ranked underneath.

---

## 1. Tier 0 — the one item that may be broken in production right now

### 1.1 Nothing stops a deploy whose code needs a migration the database does not have

`railway.json:8` points the healthcheck at `/health`, and `src/index.ts:77-79` serves that from pure
memory — it never touches Postgres. `/health/db` (`src/index.ts:81-91`) does connect, but issues only
`select 1 as ok` and asserts nothing about schema version. `railway.json` declares no
`preDeployCommand`, and `docs/deploy.md:82-84` states the consequence plainly: *a schema change does
not apply itself on deploy.*

This is live risk, not a hypothetical. Migration `0013_chunk_tsvector.sql` landed 2026-08-06
(`4bfd891`) and `src/search/hybrid.ts:387-401` hard-references `c.content_tsv` in the keyword arm. A
production database that has not had `bun run migrate` run since that commit will pass the Railway
healthcheck, serve the SPA, accept an upload — **and throw on the keyword arm of every `ask`.**

The repo already contains the correct pattern one function away: `assertWebBuildPresent()`
(`src/index.ts:99-101`) refuses to boot when the UI build did not run, under the comment *"silently
wrong rather than obviously off."* The schema half of that idea was never built, even though `doctor`
already classifies pending/orphan/drifted migrations (`src/db/doctor.ts:466-486`).

**Check first — `migrate` is idempotent:** `bun run migrate && bun run doctor` against the production
database.

**Left:** either a boot-time `assertSchemaCurrent()` in `src/boot.ts` reusing `classifyLedger` from
`doctor.ts` (fail-closed like `assertWebBuildPresent`, exempt on loopback), or make `/health/db`
return the pending-migration list and repoint `railway.json`'s `healthcheckPath` at it. ~40 lines plus
a test. **Size: S.**

---

## 2. Tier 1 — the M5b register (named by the roadmap, not required by the gate)

### 2.1 Teams, end-to-end — **XL**, and the single largest remaining chunk

The substrate exists and is completely inert. Three corrections to how `CONTEXT.md` §5.1 describes it,
each of which *lowers* the estimate and each verified against the policy fixtures:

1. **The tables are real.** `src/db/schema.sql:113-142` creates `teams` and `team_memberships` with
   composite same-tenant FKs; `schema.sql:295-301` enables RLS on both.
2. **They are not equally write-blocked.** `acl_grants_ws` is `TO cb_app … WITH CHECK (false)`
   (`0001_m2_auth.sql:89-92`), but `teams_ws` and `team_memberships_ws` were never re-created by
   `0001` and keep `schema.sql`'s `{public}` policies with plain workspace-equality `WITH CHECK`. A
   tenant-confined team write is *already permitted by RLS* — only the table privilege is revoked
   (`src/db/migrate.ts:353-355`). That makes the write path exactly the `create_invite` shape
   (`src/api/operations.ts:471-493`).
3. **The "sixth `SECURITY DEFINER`" is a design preference, not a blocker.** `team_memberships_ws`'s
   qual carries no `current_grants()` term (confirmed in `test/fixtures/expected-policies.json`), so a
   two-phase read inside a self+ws-keyring `withScopedTx` works today with zero new SQL. The definer
   is still the right call — it preserves the one-DB-call invariant stated at `src/auth/resolver.ts:5-9`
   — but choosing the two-phase read is legitimate and cheaper.

Five sub-items, independently shippable in this order:

| # | Sub-item | Size | What it is |
|---|---|---|---|
| a | **Write path** | M | `create_team` / `assign_member` / `list_teams` ops, admin-gated, `withScopedTx`, modelled on `create_invite`. Change `migrate.ts:354-355` from a blanket revoke to `revoke update, delete` while keeping INSERT — the `invites` precedent at `migrate.ts:361-362`. Re-derive `test/fixtures/expected-grants.json`. |
| b | **Keyring read** | M | `resolveGrants`' `extra` parameter (`src/core/context.ts:77`) is dead at **11** call sites — 4 production (`auth/resolver.ts:122`, `api/call.ts:37`, `api/mcp.ts:24`, `api/dev-auth.ts:98`) and 7 in `scripts/`. Either extend `cb_internal.resolve_session` (`migrate.ts:420-440`) — note a `RETURNS TABLE` change needs DROP+CREATE, the exact hazard `migrate.ts:396-403` warns silently restores `PUBLIC EXECUTE` — or take the two-phase read. `scripts/novabyte-eval.ts:66` must follow or the harness meant to *prove* the fix still cannot see team pages. |
| c | **`scope='team'` plumbing** | L | `PAGE_SCOPES` (`context.ts:95`) and `aclForScope` (`:107-109`); a new migration `0014` redoing `pages_scope_ck` (`0003:23`) **and adding a third partial slug index** — `0007_acl_rls.sql:135-138` replaced the single UNIQUE with two partial indexes predicated on `scope='workspace'`/`'private'`, so a third value would carry **no slug uniqueness at all**; a third `COLLISIONS` entry in `src/ingest/import.ts:78-86` (it matches on the *index name* to build its 409); a team branch in `lifecycle.ts:481-486`'s rescope pre-check; `doctor.ts:597-601`'s hardcoded two-scope IN list. Op schemas at `operations.ts:161`, `:316`, `:381` are `z.enum(PAGE_SCOPES)` and **cannot use `.refine()`** for a conditional `teamId` — the registry rejects anything that is not a bare `z.ZodObject` (`operations.ts:524-529`, trap recorded at `:264-267`). |
| d | **UI** | M | A third option in the `ScopePicker` (`web/src/components/Upload.tsx:250-258` — a 2-col grid, so a real layout change, not a list append) plus a team selector, and an admin screen. Note the *read* side is already team-aware: `Home.tsx:238-250` filters `grants` for `team:` and renders "+ N teams", and `ScopeBadge.tsx:18-28` fails closed on unknown scopes so a team page is never mislabelled "Everyone". |
| e | **Guardrails** | S | Four meta-tests go red the moment any of the above lands, and the vendored spec counts none of them: `test/acl-tag-format.test.ts:73-119` paren-scans every `resolveGrants(` and **fails on any third argument**, with an anti-vacuity floor of ≥8 sites; `doctor.ts:581-588` reports any well-formed `team:` tag as a defect; `doctor.ts:597-601` as above; `test/live-gate.test.ts:194-251` asserts in *both* directions, so a new team live-suite must be registered. Plus three fixtures (`expected-grants`, `expected-definers` — it pins `body_md5`, so any function-body edit fails doctor — and `expected-policies`). |

`docs/enabling-team-scope.md` is vendored and names five touch points; the real count is ~10, and its
own preface admits four of the six ways it is stale. **If the answer to §6.1 is "not yet", the cheap
middle path is (a) + (b) alone** — both self-contained, and together they make the NovaByte harness
honest (it drops 36 of 105 pages and 54 of 68 visibility cases today).

### 2.2 Conversations / memory — **L**, entirely greenfield

Nothing exists. No `src/memory/`, no `conversations`/`messages` tables in `schema.sql` or any of the
13 migrations, no op takes a conversation id, and `answerQuestion(ctx, question)`
(`src/answer/answer.ts:127`) takes exactly two parameters. The browser is single-shot too:
`web/src/screens/Home.tsx:168` holds one `result` in `useState` and `:175` clears it on every submit,
so **a second question destroys the first answer and its citations.**

**Left:** two tables + RLS carrying the day-0 tenancy columns; `citations jsonb` per message; ops;
the rolling-summary compaction — a second paid model call per N turns, which must sit **outside**
`withScopedTx` per D6; and the "grants re-checked on reuse" rule, which means re-resolving each stored
citation's chunk through the caller's *current* keyring rather than trusting the persisted jsonb.
`docs/screens.md:101` already specifies the UI consequence: stale/revoked citations become reachable
only once this lands, and must render identically for deleted and access-revoked or the chip becomes
an oracle.

### 2.3 MCP over HTTP + an agent credential — **L**

`tools/list` and `tools/call` are implemented and are already transport-independent
(`src/api/mcp.ts:71-106`), but `mcp.ts:6` imports only `StdioServerTransport` and `:121` is the single
bind. The file calls itself *"a local single-operator bridge, NOT a multi-tenant surface"* (`mcp.ts:3-4`).

There is **no machine credential of any kind**: no token table in `schema.sql` or any migration; the
only two hashed credentials are human-bound (`sessions.token_hash`, `invites.token_hash`); agent
identity is `CB_MCP_PRINCIPAL`/`CB_MCP_WORKSPACE` read from process env. The seam is declared and
dead — `OperationContext.actingAgent` (`src/core/context.ts:33`) has no caller anywhere.

**Left:** a workspace-scoped token table (sha256 `token_hash`, revoked_at, expires_at); mint/revoke
ops with `create_invite`'s display-once pattern; a lookup that runs **before** any workspace GUC is
set — i.e. a sixth `cb_internal` definer, since the tenant pool cannot read a token row without
already knowing the tenant; a `resolveAgentContext()`; and an Express `/mcp` route. Two non-obvious
notes: `buildHandlers()` takes no identity and memoizes a process-wide context for 30s
(`mcp.ts:43-56`), so it must be refactored to accept a per-request context before it can serve many
tenants; and `/mcp` must be added to `bodyLimitFor` (`src/api/server.ts:86`) or agent `ingest_file`
uploads 413 at the app-wide 100kb cap. The zod→JSON-Schema step `plan.md:429` asks for is already
done (`src/api/tool-defs.ts`).

### 2.4 Per-workspace spend cap + ledger — **M**

What M4 shipped is a **rate meter, not a spend cap**, and `src/api/dispatch.ts:124-126` says so in
code. `apiLimiter` is 120 req/min keyed on the **principal** (`src/auth/ratelimit.ts:89`), so N members
= N×120/min against one shared `OPENROUTER_API_KEY`; it prices nothing (120 one-word asks cost the same
as 120 that each embed a 5 MB document); and its buckets are a per-process `Map`, so it survives
neither a restart nor a second instance.

The measurement half now half-exists: `logUsage()` (`src/ai/router.ts:246-253`) emits one
`console.info` per call carrying token counts, deliberately *before* response validation so a
moderation refusal that still bills is counted. But it has no workspace attribution, no persistence,
and **`rerank()` never calls it** (`router.ts:404-437`), so Cohere spend is uncounted entirely.
`RouterScope.workspaceId` exists with the comment *"M5 spend caps key on this"* (`router.ts:51`) and
nothing reads it.

**Left:** a usage table keyed on `workspace_id` with the tenancy columns and RLS; attribute `logUsage`
to `requireScope().workspaceId` and write **transactionally, failing closed** (`plan.md:209` — the
inverse of gbrain's fail-open); a price table per model id; a pre-flight check at dispatch rung 0
beside the existing limiter; wire `rerank()`; and the shared limiter store, which belongs in the same
change.

### 2.5 The rest of Tier 1, each self-contained

| Item | Size | State and what is left |
|---|---|---|
| **Member roster UI** | S | `list_members` is **built** and admin-gated (`operations.ts:105-114`, registered `:501`); no React file calls it. A tab in `Home.tsx` behind the same `hasRole(who.role,'admin')` gate the Invite tab uses (`Home.tsx:84`). **One decision inside it:** the op returns raw `principal_id` UUIDs and no email or name, so either the select widens to join `principals` or the screen ships a UUID column. No removal path exists and none is cheap — `migrate.ts:352` revokes DML on `workspace_members`, so removing a member needs a definer, not a handler. |
| **Page detail screen** | S | `get_page` is **built** (`operations.ts:239-249`) and agent-facing only. A fifth route in `App.tsx`'s hand-rolled `useRoute`, a component (full text + `ScopeBadge` + chunk count + the `truncated` notice), and clickable rows in `PageList.tsx`. States are already specified at `screens.md:138-142`, including one message for `not_found` vs not-visible so the screen is not an existence oracle. Beware D98.5: `navigate()` uses `replaceState` because its only caller today is the post-accept hop — the next screen inherits that silently. |
| **Invite lifecycle** | M | The substrate is further along than it looks: `schema.sql:166` declares `status` defaulting to `'pending'` and `:179` documents all four states; `migrate.ts:362-363` revokes UPDATE then re-grants `update (status)` to `cb_app` *precisely so a revoke op can flip it*. Only one transition is implemented (`invites.ts:118-121` writes `'accepted'`); nothing ever writes `'revoked'` or `'expired'`, and `invites.ts:106` notes the accept statement is the **only** enforcement of `INVITE_TTL_DAYS` — nothing sweeps. `listPendingFor()` was deleted with a note saying it returns at M5 (`invites.ts:163-168`). Left: reinstate it, add `list_invites` + `revoke_invite`, derive expired-vs-pending at read time. |
| **Workspace switcher** | M | *Switching* is built and wired — `POST /auth/workspaces/:id/activate` (`routes.ts:219`) is called from `AcceptInvite.tsx:151`. The **listing** half is missing: no route enumerates a principal's memberships, `whoami` returns a single `workspaceId`, and the Home header (`Home.tsx:56-71`) shows one name with no control. D98.7 defers the definer's design here deliberately. Follow D35's locked signature as precedent — it takes no principal argument specifically so it cannot become a membership oracle. |
| **Workspace settings** (domain claim + ZDR) | M | Two deferred items land on one screen. **Domain claiming**: the endpoint *is* reachable (`routes.ts:199-216` reads `body.domain`), but the SPA deliberately never sends it (`CreateWorkspace.tsx:27-31`), so no web user can ever claim a domain — while `Invite.tsx:131-141` leads with a DomainNote advertising auto-join, an affordance the app gives no way to turn on. A later claim must read the *claiming* session's `login_hd` (`0001_m2_auth.sql:32`), not the creating one. **ZDR**: D12 and D91 both carry the correction — *"do not represent ZDR as available to a design partner."* `router.ts:277` acts on `scope.zdr` and all six call sites hardcode `false`; there is no column. Needs `zdr boolean` on `workspaces` + grant matrix + doctor fixture. |
| **Answer: Conflicts / Gaps** (A1 remainder) | M | Three of A1's five elements shipped — numbered chips (`AnswerView.tsx:122-133`), source panel with scope badge (`:136-139`), and confidence, built *differently* from A1 as a three-state client-side derivation from evidence rather than a model self-report (`api.ts:298-310`). Conflicts and Gaps still do not exist and **no doc records a decision to drop them.** Left: either extend the output contract at `prompt.ts:31-32` and widen `parseAnswerJson` (`answer.ts:79-125`, which must stay degrade-never-throw) with the same clamp the citations get, plus the containers — **or** a DECISIONS entry saying A1 was consciously reduced, which is what actually happened. **Since this item was written, `AnswerResult` grew a sixth field, `parseDegraded: boolean`** (`answer.ts:30-40`, from the eval-harness merge) — distinguishing "the model cited nothing" from "the response could not be parsed at all", which the abstention tier of the new RAG eval needs. Not a Conflicts/Gaps field itself, but any extension here has to compose with it rather than re-solve the same distinction. |
| **Session refresh rotation** | M | D34 cut it from M2 and says it returns at M5. `sessions.refresh_hash`/`refresh_expires_at` exist and are inert (`schema.sql:85,88`); there is no `/auth/refresh`. D34 also notes reuse detection was unimplementable as originally reviewed because only hashes are stored — **the design needs redoing, not just coding.** |
| **Invite email delivery** | M | `plan.md:194` says "invite by email"; nothing in the repo sends mail (no SMTP/Resend/Postmark/nodemailer dependency or config anywhere) and the op says so itself (`operations.ts:475`: *"M2 sends no email; copy the URL"*). The invite *is* bound to the email — single-use token, hash-only storage, accept-on-matching-login — so "by email" holds as **matching** but not as **delivery**. Left: a provider, or an explicit amendment to `plan.md:194` recording copy-the-link as the shipped v0 behaviour. |
| **Operator + tenant ops panel** (A19) | M–L | None of A19's four exists: no counts op, no last-ingest readout, no spend figure (blocked on §2.4), no HTTP surface for doctor (`package.json` maps it to a CLI over the admin pool). The hard constraint is in `screens.md:144-150`: doctor connects with **owner** credentials, so its output cannot sit behind a workspace-admin route — *"two audiences, not one"*, and the split must exist before either half is built. `web/src/index.css:42-45` already declares the operator palette and nothing consumes it. |

---

## 3. Tier 2 — cheap, and on the founder friend's actual path

These four are the only remaining items that touch the gate. Together they are well under a day.

1. **The scope picker's copy is now false.** `Upload.tsx:275-277` tells the user the scope *"cannot be
   changed later — you would have to delete the page and add it again"*, and the docstring at
   `:233-235` repeats it. Both were true when written in `a9d43f1` and stopped being true in
   `07aee51`: `rescope_pages` is registered (`operations.ts:506`), the `ingest` op's own description
   advertises it (`operations.ts:126-127`), and `PageList` calls it from the UI (`PageList.tsx:70`,
   buttons at `:101-116`). This is the one hesitation point in the upload flow and it is lying.
   **Delete three sentences.**
2. **Cold-start's second half.** The empty-brain drop zone shipped (`Home.tsx:145-162`) as a
   *deliberate revision* of A3 — sample questions belong after the first document, generated from it
   (`Home.tsx:140-143`, `screens.md:93`). That relocated version was never built. Worse, after a
   successful upload `Home.tsx:114-121` sets `isEmpty(false)` but **does not switch the tab**, so the
   user is left on 'add' with "Add another" as the only affordance and no path back to Ask. The
   minimum fix is a hand-off in `UploadResult` that calls `setTab('ask')` and prefills the textarea;
   the full A3 treatment needs question generation from the ingested page's headings.
3. **No demo script.** `plan.md:196` names it; `docs/` has six files and none is one. Needs the
   ordered narrative (sign in → create workspace → upload with the scope picker → ask → read the cited
   answer → invite → show the colleague *cannot* see the private page) plus the operator preamble:
   which URL, which workspace, what state to reset to between runs.
4. **The seed cannot be aimed at a real person.** `seed:a17` + `load:a17` genuinely work and the docs
   undersell them — 12 markdown files of a coherent fake company, ingested through the *real* `ingest`
   op. But `scripts/seed-a17.ts:6` hardcodes `a17-founder@example.com` and `:17-19` inserts no
   `google_sub`, so no Google account can ever resolve to that principal; a real founder signing in
   lands workspace-less and creates an empty one. And `load-a17-corpus.ts:54` passes no scope, so
   every seeded page lands at `workspace` — **the seeded corpus cannot demonstrate the
   private/workspace distinction the demo exists to show.** Left: a `CB_SEED_EMAIL` that resolves an
   existing principal, plus a `scope` on two or three corpus files.

---

## 4. Tier 3 — trust and infrastructure

### 4.1 The leak canary has never run on a runner

Verified directly, not inherited from `CONTEXT.md`: `gh secret list` returns **empty**, and every
master run since the workflow existed is `failure` — run `31250108386` shows `offline` passing in 37s
and `live isolation suite (leak canary)` dying in 6s at *Apply migrations*, the exact signature of
absent connection strings. The job needs **ten** secrets, not the seven `CONTEXT.md:100` lists (it
omits `OPENAI_API_KEY` and `OPENROUTER_API_KEY`): `.github/workflows/ci.yml:99-103`, `:118-119`,
`:128`, `:132-133`.

So D16's *"runs in CI forever"* is currently false in **both** senses: the job is master-only
(`ci.yml:80`) *and* it has no credentials. `ci.yml:71-77` states the cost in the file itself and names
the real fix: **a second database for CI.**

**The approach was already decided on 2026-08-09 and the decision is not recorded anywhere in this
repo** — no `DECISIONS.md` entry, and the `docs/ci-setup.md` it refers to exists on no branch. It is
transcribed here so it survives. Two blockers were found upstream of the secrets, neither of them in
any repo document: GitHub was **not scheduling** the `live` job at all (no runner, zero steps,
cancelled at 15m, while `offline` passed in the same run — the exhausted-minutes / spending-limit
signature on a private repo), and the canary **could not gate a merge** anyway
(`branches/master/protection` returns `403 "Upgrade to GitHub Pro or make this repository public"`;
required status checks do not exist on private free-tier).

The locked sequence, in this order — all six steps are the founder's to perform, none is a code task:

1. **Rotate** the Supabase database and both role passwords (a review subagent leaked connection
   strings into its own output).
2. **Review `CONTEXT.md` §6 before publishing** — it enumerates security findings by SHA, and §6.3
   and §6.4 are open. This is the step with no undo.
3. **Make the repo public** — resolves both blockers at once. Git history was verified credential-free
   across all 49 commits first (`.env` never committed; only `.env.example` placeholders match
   credential patterns).
4. **Stand up a separate CI Supabase project** — a *precondition* of setting secrets, not a follow-up,
   because `ci.yml:80` accepts `workflow_dispatch` on any ref and that is where an owner credential
   would land.
5. **Set the ten repo secrets** from that project (enumerated in §4.1 above).
6. **Restore `branches: ['**']`** at `ci.yml:80` and make `live` a required status check. D16's "runs
   in CI forever" becomes true here and not before.

### 4.2 The rest

| Item | Size | State |
|---|---|---|
| **CI runs `migrate` once** | S | `doctor.ts:9-10` states its own precondition: run it *after* migrate has run **twice**, because the highest-value regression (`grantExisting` re-broadening every table on every run) is an idempotency bug a single run cannot catch. `ci.yml:104` runs it once. `docs/deploy.md:86-87` gets this right for humans. **One line.** |
| **Railway is captured but not reproducible** | M | Four gaps, each admitted by `docs/deploy.md` itself: secrets are dashboard-only (`:5-6`); **no Dockerfile, `.tool-versions`, bunfig or `.bun-version` anywhere**, so Railway picks its own Bun while CI pins 1.3.14 (`:33-35` says the drift "is not currently pinned anywhere" and `:58-61` names the Dockerfile as the fix); migrations never auto-apply (§1.1); and it is **single-replica-only**, because the rate limiter (`ratelimit.ts:20-21`) and the extract admission gate are both process-local — `:99-105` says both "silently stop working as intended above one replica". A `Dockerfile` (`FROM oven/bun:1.3.14`) plus dropping `engines.node` collapses most of this. |
| **doctor is blind to platform roles** | S | D99's own prescription, unimplemented: assert `anon`/`authenticated` hold no privilege on any `public` table, and that no role but `postgres` has `rolbypassrls`. Both are single catalog queries in the existing `booleanChecks` shape (~15 lines), and they convert a dashboard toggle from unverifiable into an assertion. *"A fixture that enumerates only what you built cannot notice what your host added."* The dashboard action itself (Data API off, auto-expose off, rotate the Seoul JWT secret) is founder-side and there is no repo-side evidence it has been applied. |
| **No DOM render test runner** | M | `package.json:21` is bare `bun test`; grepping `package.json` and `bun.lock` for jsdom / happy-dom / @testing-library / vitest / playwright returns **zero**. All three web suites say so in their own headers and are string scans over `web/src`. A component can render the wrong thing with a fully green suite. Note the scans should **not** be deleted if a runner lands — `web-render-safety`'s value is catching a decision at the moment it is made, which no render test can. |
| **`docker-compose.yml`** | S | Named in M0's file list (`plan.md:150`), never created. The consequence is a live setup gap: a Supabase account plus three pooler strings before anything is verifiable. Enforced floors for the file: PG ≥ 15 (`migrate.ts` throws below) and pgvector ≥ 0.8 (`doctor.ts:294`). `config.ts` supports `DB_SSL=disable` and no doc mentions it. |
| **A5's voice guide** | S | Tokens shipped and name their own amendment (`web/src/index.css:1-60`); the one-page voice guide was never written. The discipline already exists implicitly and consistently in the component docstrings — `screens.md:70`, `:123`, `:125` all argue the same rule about never distinguishing failure modes that would make a screen an oracle. Writing it down is transcription, not design. |

---

## 5. What is *not* on this list, and why

Reported here so nobody re-opens them. Each was checked, not assumed.

- **A2 (UI states)** — degraded banner, retry-after countdown, partial-extraction reporting all ship;
  `screens.md:100-101` correctly argues permission-denied is unreachable on `ask` and stale-citation is
  unreachable until conversations exist.
- **A4 (scope naming)** — `Upload.tsx:255-256` ships exactly "Only me" / "Everyone at {Workspace}",
  shaped to grow to teams. (Its irreversibility copy is stale — §3.1 — but A4 itself is done.)
- **A5 (design tokens)**, **A7** (pgvector floor + `iterative_scan`, asserted at `doctor.ts:294`),
  **A8** (tx never wraps the model call), **A9** (compiler-required grants), **A10** (identity-table
  RLS + the enumeration test at `test/leak-canary.test.ts:340-382`), **A16** (error taxonomy) — all
  built.
- **Confidence signal and citation IA** — built, though `plan.md:290` and `:320` still score them as
  open gaps. Anyone reading `plan.md` alone will re-scope work that exists.
- **Deploy itself** — done. `railway.json` + `docs/deploy.md` exist and the instance runs; what is
  missing is reproducibility (§4.2), not the deploy.

---

## 6. Open decisions — the answer changes what gets built

1. **Is team scope in v0 at all?** The roadmap's text says yes (`plan.md:194`); the gate does not need
   it; `README.md:18` already tells readers it is M5b. It is plausibly the single largest remaining
   chunk, for a capability nothing on the self-serve path exercises. HANDOVER ranks it #1, but on
   **eval-coverage** grounds (36 of 105 NovaByte pages, 54 of 68 visibility cases), which is a
   proof-of-correctness goal rather than a demo goal. *The cheap middle: ship §2.1(a)+(b) only.*
2. **Where does spend accounting live?** A four-way disagreement, all read directly: `plan.md:209`
   says M8, `plan.md:382` (A15, adopted the same day) says M5, D18 says M5, and `CONTEXT.md` rules for
   M5 in §5.3 while its own milestone table at `:226` says M8. **A one-line ruling, then edits to
   whichever three locations lose.** It has now survived two milestones and three documents.
3. **"Readable" ≠ "publishable."** `answerQuestion` has no `audience` parameter and nothing filters
   retrieval to an ACL superset, so a request to draft a company-wide FAQ can pull the asker's private
   material into text meant for everyone. Nothing is *broken* — every row returned is one the asker
   may read — but the output's audience is unmodelled. Two unanswered questions: is it v0 scope, and
   does it belong on `ask` or on a future `draft`/`publish` op? Note a richer audience picker needs
   teams, so a two-value audience is the only version buildable today.
4. **UC6 — discovery and the vertical.** `plan.md:433` assigns it to the founder and says it should
   have gated M0. M0→M5a have all shipped; no doc records a discovery conversation, an ICP or a chosen
   vertical. M5's own done-when ends *"→ Pitch; convert 2–3 into design partners"*, which assumes a
   known ICP. **The only item here whose next action is conversations rather than code.**
**Not open, listed so it is not re-litigated:** which database CI points at was **settled on
2026-08-09** — a separate CI Supabase project, behind making the repo public. The six-step sequence is
in §4.1. It is pending execution, not pending a decision.

---

## 7. Corrections to the other docs, found while verifying this

Three were fixed in place in the same change that created this file (`docs/screens.md`'s Invite path,
its accept-invite primary, and its "rows are not interactive" claim). The rest are recorded here
rather than fixed, because they live in files whose voice and structure make a drive-by edit worse
than a pointer:

- **`CONTEXT.md:333-337`** says "Ten call sites, not one" and lists ten. The real count over
  `{src,scripts}` is **eleven** — it misses `scripts/explain-search.ts:73` — and it cites
  `scripts/measure-a17.ts:67` where the call is at `:65`. Eleven is the number that matters because
  `test/acl-tag-format.test.ts:87` globs exactly `{src,scripts}/**/*.ts`.
- **`CONTEXT.md:329-332`** ("needs a sixth `SECURITY DEFINER`") and **`:326-328`** (the three tables
  are equally write-blocked) — both overstated; see §2.1.
- **`CONTEXT.md:100`** says the live CI job reads seven secrets. It reads **ten**.
- **`docs/plan.md:290` and `:320`** score the confidence signal and citation IA as open gaps. Both
  shipped in M5a.
- **`README.md:106-107`** still says "no remote machine credential until M3". M3, M4 and M5a have all
  shipped and there still is none — the fact is true, the milestone is stale.
- **The doctor check count is disputed and unmeasured.** `README.md:54` and `:158` say 73;
  `CONTEXT.md:711` says 75. Neither was re-measured here because it needs a live database. One
  `bun run doctor` settles it — do that before quoting either number.
- **`docs/deploy.md:75-76`** claims an unset `NODE_ENV` "skips that whole block" of secret checks.
  False since `6410c8d`: `isDevEnv` requires an explicit `NODE_ENV` (`config.ts:135-137`,
  `boot.ts:66-70`). The same file never mentions `DB_SSL`, despite `config.ts:205-208` only *warning*
  on weak TLS in production and `f33272b` existing precisely because a pasted Railway value silently
  downgraded verification.
- **`docs/screens.md`** does not document the batch-management surface at all — selection checkboxes,
  delete / make-private / share-with-workspace, a destructive `confirm()` and a partial-success report
  (`PageList.tsx:23-25`, `:55-79`, `:95-150`) all landed in `07aee51`, after the inventory was last
  touched.

---

## 8. How to use and refresh this file

**Reading it costs a few thousand tokens; re-deriving it cost roughly 1.3 million.** That is the whole
argument for its existence. When starting a session about what to build next, read this and
`CONTEXT.md` §0 — not `docs/plan.md`, whose M5 section is the least reliable of the four on status.

To refresh it: the method that produced it was six parallel area audits (teams/keyring, web surfaces,
product backend, agent surface, deploy+CI, cross-doc scope reconciliation), each followed by an
adversarial verifier prompted to **refute** the auditor's "missing" claims by finding the
implementation they overlooked. Six claims were corrected that way — every one of them in the
direction of *more built than reported*, which is the bias to expect when auditing against roadmap
documents rather than code. Budget the refutation pass; the raw audit alone would have shipped six
wrong statuses.
