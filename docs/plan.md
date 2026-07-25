# Company Brain — v0 Architecture & Decisions

## Context

We are building **company-brain**: a greenfield, multi-tenant **SaaS** knowledge brain in
TypeScript (India-first, Google-centric, invite-driven, demo-first). The repo is empty. Two
build plans exist (`company-brain-build-plan.md` and `-v2.md`); **v2 is canonical**, v1 is the
superseded draft.

Before writing code, an 8-subsystem recon read the reference implementation at
`/Users/taherpanbiharwala/dev/gbrain` (Garry Tan's gbrain, MIT, v0.42+). It established one
decisive fact that the plans under-state:

> **gbrain is single-owner, source-level, and app-enforced.** There is no `workspace_id`, no
> `acl text[]`, no `owner_principal`; isolation is enforced in TypeScript (`sourceScopeOpts` →
> `WHERE source_id = ANY(...)`), **not** in the DB; there are **zero `CREATE POLICY`** statements
> and the app runs as a **BYPASSRLS** role; "each teammate's login" is a **machine-to-machine
> OAuth client** with a static `federated_read` array — **no user login, no sessions, no invites,
> no org/team/role membership graph**. The "zero-leak fuzz test" validates the app-layer resolver,
> not row-level ACL.

**Therefore v0 = port the brain loop + build the identity/tenancy/RLS layer net-new.** This
document locks the tenancy model, records the irreversible decisions, and specifies M0 in
execution detail. Confirmed direction (from Q&A): rebuild reusing patterns; **columns exist
day-0, enforcement phases in**; produce this architecture doc before any code-level plan.

---

## Locked decisions (seed for `DECISIONS.md`)

1. **Multi-tenant from row zero.** Every content table carries `workspace_id uuid NOT NULL`,
   `scope text NOT NULL`, `acl text[] NOT NULL`, `owner_principal text NOT NULL`. These are
   one line now and a brutal migration later — non-negotiable in M0.
2. **Enforcement phases in, columns don't.** App-layer resolver (fail-closed) from M0 → per-row
   `acl && grants` in engine queries at M3 → real Postgres RLS backstop on a non-BYPASSRLS role
   at M4 → team/role grants expand the keyring at M5.
3. **Fail closed, never `{}`.** A request with no resolvable `workspace_id`/grants **throws**.
   We do **not** port gbrain's `return {}` (unfiltered) fallback — its single worst footgun.
4. **`workspace_id` is load-bearing in constraints**, not a "later" column: `UNIQUE(workspace_id,
   slug)`, `UNIQUE(workspace_id, idempotency_key)`, rate-lease keys, spend keys, dedup/cache keys
   — all carry it from the first migration.
5. **Isolation lives in the DB (RLS), app-layer is defense-in-depth** — the inverse of gbrain,
   which the recon shows only ever sketched RLS in a comment behind an off-by-default flag.
6. **One door for every model call** (`src/ai/router.ts`) with OpenRouter + `zdr:true` default.
   gbrain has no ZDR and defaults Anthropic-direct — this is net-new.
7. **`kind` is TEXT, never an enum.** One hard-coded generic pack (person, company, project,
   process, note) as data. OKF-aligned page fields (`title, description, tags, status,
   owner_principal, created_at, updated_at`); `kind` → OKF `type` at export.
8. **The leak-canary test (M3) runs in CI forever and is never skipped to move faster.**
9. **Stack:** Bun + TypeScript (strict) · Express 5 · Postgres 16 + pgvector via `postgres.js`
   (raw SQL) · zod for op schemas · Google OIDC (openid-client) · OpenRouter for chat · Vite +
   React + Tailwind SPA served by the same Express · `docker-compose` local, Railway/Fly single
   instance for the demo, GCP Mumbai at M8.

---

## The tenancy model (locked)

### Columns (every content table: pages, content_chunks, tags, links, …)

| Column | Type | Meaning |
|---|---|---|
| `workspace_id` | `uuid NOT NULL` | The tenant. Required in every WHERE, UNIQUE, and RLS policy. |
| `owner_principal` | `text NOT NULL` | Creator; the self-grant. |
| `scope` | `text NOT NULL` | Coarse label. v0: `'private'` \| `'workspace'`. Extensible (team/role later). |
| `acl` | `text[] NOT NULL` | Grant tags. A row is visible iff `acl && caller_grants`. GIN-indexed. |

**Denormalize `workspace_id` (and `acl`) onto `content_chunks`, `tags`, and `links`** — in
gbrain these carry only `page_id` and inherit tenancy transitively. That does not survive RLS:
a JOIN-to-parent on the HNSW vector hot path is a perf trap and a leak surface. Stamp them in
the write path (`upsertChunks`/`addTag`/`addLink`), inside the same transaction as the page.

### The grants keyring (`grants[]`)

Resolved once per request from the authenticated principal:

- **v0 (M3):** `grants = { self:<owner_principal>, ws:<workspace_id> }` — self + workspace-all.
- **M5+:** union in `team:<id>` per membership and `role:<r>` — the plan's *org ∪ teams ∪ roles
  ∪ self*. The **union pattern** ports from gbrain's `sourceScopeOpts`; the membership graph it
  unions from is net-new (new `principals`, `team_memberships`, `acl_grants` tables).

A row set `scope='private'` gets `acl = ['self:'||owner_principal]`; `scope='workspace'` gets
`acl = ['ws:'||workspace_id]`. Visibility = `acl && grants`. Fail-closed if grants unresolved.

### Enforcement timeline

| Phase | What enforces isolation |
|---|---|
| **M0** | Columns exist. RLS **enabled** (permissive policies OK). App connects as a **non-BYPASSRLS role from day one** to avoid gbrain's trap. `OperationContext` requires `workspaceId` + `grants`. |
| **M3** | `WHERE workspace_id = $w AND acl && $grants::text[]` in the **engine** query methods (keyword, title, vector) on **all three** search return paths (no-embed, embed-fail fallback, full hybrid). Leak-canary green. |
| **M4** | Real `CREATE POLICY … USING (workspace_id = current_setting('app.workspace')::uuid AND acl && string_to_array(current_setting('app.grants'), ','))`; per-request tx with `SET LOCAL`; buggy-query test; `doctor.ts` RLS-posture check. |
| **M5** | `team_memberships`/`acl_grants` land; keyring resolver unions team+role grants; admin team management. |

---

## Portable vs. net-new (corrected gbrain references)

**Port the pattern (patterns, not schema):**

- **Spine:** `gbrain/src/core/operations.ts` (ops-as-data), `src/mcp/dispatch.ts`
  (validate→ctx→handle→uniform JSON envelope, `summarizeMcpParams` redaction), `src/mcp/tool-defs.ts`
  (ParamDef→JSON-Schema), `src/core/scope.ts` (RBAC `IMPLIES`/`hasScope`). **Do not** port
  `src/commands/serve-http.ts` wholesale — it's a 2,300-line OAuth/admin monolith; extract only
  the ~280-line `/mcp` handler slice.
- **Ingest:** `src/core/import-file.ts` (`importFromContent` single-waist, embed-**before**-tx
  then one atomic tx), `src/core/content-sanity.ts` (pure assessor), `src/core/chunkers/{recursive,semantic,code}.ts`.
- **Search:** `src/core/search/hybrid.ts` (RRF fusion `rrfFusionWeighted`, `cosineReScore`
  0.7/0.3 blend), `src/core/search/dedup.ts` (4-layer), `src/core/search/sql-ranking.ts`
  (fragment-builder pattern — add a sibling `buildAclClause`). Backoff/batching actually lives in
  `src/core/ai/gateway.ts`, **not** `embedding.ts` (a thin delegate) — point the port there.
- **Router:** `src/core/ai/gateway.ts` + `src/core/ai/recipes/` (pure-data Recipe registry,
  `provider:model` convention, `assertTouchpoint` allowlist) + `src/core/model-config.ts`
  (`resolveModel` precedence) + `withBudgetTracker` AsyncLocalStorage (template for per-workspace
  scoping).
- **Queue (M6):** `src/core/minions/queue.ts` (`FOR UPDATE SKIP LOCKED`, token-fenced state
  transitions, leases w/ `expires_at`, backoff+jitter, idempotency via unique partial index).
- **Graph (M7):** `src/core/link-extraction.ts` (pure regex typed edges + source-scoped resolver
  — ports near-verbatim, rename `source_id`→`workspace_id`), `src/core/cycle.ts` phase framework.
- **Leak canary:** `gbrain/test/get-page-federated-scope.test.ts` is a ready template (seed 2
  tenants, grant a subset, assert zero bleed across every read op).

**Build net-new (no gbrain starting point):** `workspace_id/acl/owner_principal` columns + real
RLS policies + non-BYPASSRLS role + per-request GUC; Google OIDC relying-party login + `principals`
+ sessions + `invites` + accept flow; the dynamic keyring resolver + membership tables; ZDR +
OpenRouter-default router; per-workspace config/spend/cache/rate-lease keys; per-scope compiled
truth + edge ACL inheritance (M7 — gbrain has one `compiled_truth` body per entity; this is the
single largest M7 item, not a tweak).

---

## v0 milestones (M0 detailed; M1–M5 at architecture level)

### M0 · Foundations *(3–4 days)* — the immediately executable step

Files to create:

- `src/db/schema.sql` — all v0 tables. Content tables carry the four tenancy columns; pages carry
  OKF-aligned fields + `kind text`; `workspace_members` join table; `UNIQUE(workspace_id, slug)`;
  GIN index on `acl`; HNSW index on the embedding column. RLS **enabled** (permissive for now).
  **`COMMENT ON` every column.**
- `src/core/context.ts` — `OperationContext { principal, workspaceId, grants[], actingAgent?, remote }`.
  `workspaceId` + `grants` **required**; a builder that **throws** when they can't be resolved (no
  `{}` fallback, no `remote===false` scope-widening).
- `src/db/client.ts` + `src/db/migrate.ts` — `postgres.js` pool (non-BYPASSRLS app role) +
  sequential `.sql` runner.
- `src/ai/router.ts` — the one door for every model call; provider/model per task from env;
  OpenRouter with `zdr:true` default; per-workspace binding via AsyncLocalStorage (not a process
  global — gbrain's singleton `_config`/`_modelCache` cache key omits tenant/key and would leak a
  cached client across tenants if BYO-key is ever added).
- `src/config.ts`, `docker-compose.yml` — env config; postgres + pgvector.
- **Infra checklist:** DB not publicly reachable, TLS enforced, secrets in a manager, backups on.

**Done when:** boots, migrates, `/health` responds, DB has no public endpoint.

### M1 · Contract spine *(4–5 days)* — BUILT (superseded by DECISIONS D26–D31)
`operations.ts` (ops as data — **RBAC governs verbs; ACL/ReBAC governs nouns**) → `dispatch.ts`
(single path: validate → context → role check → run → redacted log) → `server.ts` (`/api/:op`) +
`redact.ts` (shape-only, 1KB buckets). Port the spine; swap gbrain's shallow validator for zod.
**Done when** `whoami` works and the log contains shapes, never values.

> **As-built (refines this sketch):** the `Operation` shape is `{name, description, params (zod
> object), requiredRole?, mutating?, handler}` — a **single role axis** (owner ⊃ admin ⊃ member),
> not a separate `scopes` + `required_role` (agent-token scopes deferred to M3). Plus a stdio MCP
> transport, `GET /api/_ops` discovery, a `bun run call` CLI, and a `reqId` on every log line +
> envelope. See DECISIONS D26–D31 and the M1 `/autoplan` review in the plan file.

### M2 · Identity *(~1.5 weeks — net-new)*
`auth/google.ts` (Google OIDC relying-party) · `auth/tokens.ts` (hashed sessions, short-lived +
refresh rotation) · `auth/workspaces.ts` (custom domain → create/join; **public-domain blocklist**) ·
`auth/invites.ts` (**invite by exact email → single-use token → accept on matching login — primary
SMB onboarding**) · `auth/resolver.ts` (the keyring). Schema add: `principals, team_memberships,
acl_grants, invites`. **Done when** a custom-domain user and an invited Gmail user land in one
workspace with distinct grants.

### M3 · The brain loop *(~2 weeks — the heart)*
`ingest/import.ts` (single waist; stamps scope/acl/owner/workspace at the door; **default scope =
workspace** — superseded 2026-07-25 by D0.1, which closed this as workspace-default with a private
option whose `acl` is derived rather than labelled; this line used to say `private`) · `ingest/sanity.ts` · `ingest/chunk.ts` (**recursive only** + thread-grouping; tags +
`workspace_id` copied to chunks in-transaction) · `ingest/embed.ts` (batched + backoff via router) ·
`search/hybrid.ts` (`acl && $grants` **inside the engine query on all three paths**; config-gated
expansion) · `answer/answer.ts` (retrieve → cheap model → cited answer) · `core/pack.ts` (one
hard-coded generic pack) · **`test/leak-canary.test.ts`** (Alice+Bob, shared+private; zero cross-leak
in results, citations, counts). **Done when** the leak canary passes and upload→ask→cited answer demos.

### M4 · Enforcement + doctor *(~1 week)*
Real RLS policies on the non-BYPASSRLS role; per-request `SET LOCAL app.workspace / app.grants`
inside a transaction that wraps every request (**tx-pooler discipline** — the GUC leaks across
pooled connections otherwise); buggy-query test (raw `SELECT *` returns only permitted rows);
`ops/doctor.ts` v1 (5 checks: DB reachable, pgvector present, migrations current, RLS posture,
ACL-tag coverage). **Done when** an unfiltered query leaks nothing and doctor is green.

### M5 · The demo web app *(~2 weeks)*
`web/` chat with citations + upload/paste with scope picker (Private | Everyone) · `web/admin`
(invite by email, **manual team create/assign**, member list) · `memory/conversations.ts`
(conversations + messages; rolling summary; citations jsonb per message; **grants re-checked on
reuse**) · deploy Railway/Fly + seed + demo script. **Done when** a founder friend self-serves
end-to-end. → Pitch; convert 2–3 into design partners.

---

## Invariants baked in from day 0 (recon-flagged leak causes)

1. Fail closed — missing `workspace_id`/grants throws, never reads all tenants.
2. Denormalize tenancy onto chunks/tags/links; never rely on transitive `page_id`.
3. Every request in a transaction with per-request `SET LOCAL` GUC (tx-pooler safe); the queue's
   lock/heartbeat (M6) needs a session-mode pool.
4. All three search return paths independently enforce the filter.
5. No trusted-local scope-widening server-side (`remote===false` is not a bypass).
6. Spend caps (M8) fail **closed**; the ledger write is transactional (gbrain's fails open).

---

## Open decisions to confirm before the code they gate

- **Embedding provider + vector dimension** (gates the `vector(N)` column + HNSW index in M0
  schema — semi-irreversible without a re-embed migration). Recommendation: **OpenAI
  `text-embedding-3-small` (1536d)** for portability + documented ZDR; ZeroEntropy `zembed-1`
  (1280d) is gbrain's cheaper default. Make the dim a config constant so the index is created at
  M3, deferring the final lock to just before embeddings are first written.
- **Hosting/pooler for the demo** (Railway vs Fly) — confirms the transaction-pooler posture that
  M4's `SET LOCAL` design must match.
- **Discovery track** — v2 starts 5–10 founder conversations in parallel with code. Confirm
  whether you want me to also produce an interview guide, or focus solely on the build.

---

## Verification (how we prove v0 is real)

- **M0:** `bun run dev` boots · migrations apply · `GET /health` returns ok · `psql` confirms no
  public DB endpoint · app role is non-BYPASSRLS.
- **M3:** `bun test test/leak-canary.test.ts` green (Alice never sees Bob's private note in
  results, citations, or counts) · manual upload→ask→cited-answer flow.
- **M4:** buggy-query test (raw `SELECT *` via app role returns only permitted rows) · `doctor`
  all-green.
- **M5:** an external founder completes login → upload → invite → ask → cited answer unassisted.
- **CI, forever:** leak canary + a structural guard (every read op threads the scope resolver) +
  `doctor` in the pipeline.

---

## Next steps after this doc is approved

1. Write `DECISIONS.md` in the repo from the "Locked decisions" section.
2. Produce the execution-ready **M0 code plan** (exact `schema.sql` table list + column comments,
   `context.ts` types, `router.ts` seam), then build M0.
3. Kick the leak-canary design early so M3 lands it as specified.

---

# /autoplan review — v0 architecture & M0 (2026-07-23)

**Voices:** Claude independent subagents — CEO, Design, Eng, DX (each read the plan + the real gbrain repo, no cross-phase context). **Codex: `[codex-unavailable — usage limit until Aug 1]`**, so this ran **single-voice**. To recover Codex's unique job (independently re-verifying the plan's gbrain claims against source), the **Eng voice re-checked the code** and scored **port-accuracy 9/10**: `sourceScopeOpts` `{}` fail-open (operations.ts:450-459), embed-before-tx atomicity, three search return paths, session-mode queue pool, RLS-only-when-role-HAS-BYPASSRLS with zero policies, dims defaults, and the federated-scope leak-test template all **CONFIRMED** against source. So the recon holds.

## Verdict scores (0-10)

| Lens | Overall | Weakest dimensions |
|---|---|---|
| **CEO / strategy** | mixed | alternatives-explored **2**, scope-calibration **3**, competitive-risk **3** |
| **Design / UX** | weak-as-written | hierarchy **2**, states-coverage **2**, onboarding-arc **2** |
| **Eng / architecture** | strong shape, 2 real gaps | rls-performance **4**, enforcement-timeline **6**; port-accuracy **9**, tenancy-model **8** |
| **DX** | strong isolation, under-invested UX | agent-surface **3**, onboarding-friction **4**, ops-observability **4**; upgrade-safety **8** |

**One-line synthesis:** the *tenancy/security engineering* is genuinely strong and the gbrain recon is accurate; the plan's real weaknesses are **(a) strategy/sequencing** (a cheaper silo path was never weighed; identity is front-loaded before demand/answer-quality is validated), **(b) two concrete multi-tenant architecture gaps** (filtered-HNSW recall collapse; RLS-tx spanning the LLM call), and **(c) the entire product-design + agent-surface layer is under-scoped**.

## Consensus tables (Claude voice · orchestrator · Codex=N/A)

Codex column is N/A this run (quota). "Orch" = my synthesis applying the 6 principles.

**CEO**
| Dimension | Claude | Orch | Consensus |
|---|---|---|---|
| Premises valid (gbrain can't be flag-flipped) | YES (verified) | YES | CONFIRMED |
| Right problem | YES, but v0 optimizes the wrong sub-problem | agree | CONFIRMED |
| Scope calibration (7-8wk solo) | optimistic → ~11-13wk | agree | CONFIRMED (re-baseline) |
| Alternatives explored (silo, fork, managed-auth) | 2/10 — waved off | agree | CONFIRMED gap |
| Competitive/wedge | GTM-only, undifferentiated v0 | agree | CONFIRMED risk |

**Eng**
| Dimension | Claude | Orch | Consensus |
|---|---|---|---|
| Tenancy model sound | 8 | agree | CONFIRMED |
| Enforcement timeline safe | 6 — M2→M4 cross-tenant window | agree | CONFIRMED gap |
| RLS performance (HNSW) | 4 — recall collapse unaddressed | agree | CONFIRMED gap |
| Port accuracy | 9 — claims verified | agree | CONFIRMED |
| Test coverage | 6 — missing intra-ws/enumeration/GUC-bleed/recall | agree | CONFIRMED gap |

**Design**
| Dimension | Claude | Orch | Consensus |
|---|---|---|---|
| Answer IA (Answer/Conflicts/Gaps dropped) | 2 | agree | CONFIRMED gap |
| UI states (partial-visibility, permission-denied) | 2 | agree | CONFIRMED gap |
| Scope-picker clarity | 3 | agree | CONFIRMED |
| Onboarding cold-start | 2 | agree | CONFIRMED gap |

**DX**
| Dimension | Claude | Orch | Consensus |
|---|---|---|---|
| Agent/MCP surface | 3 — unmilestoned | agree | CONFIRMED gap |
| Onboarding friction (Gmail blocklist) | 4 — bootstrap dead-end | agree | CONFIRMED gap |
| Ops observability (spend caps at M8) | 4 | agree | CONFIRMED gap |
| Upgrade safety | 8 | agree | CONFIRMED strength |

## Architecture dependency diagram (v0, with review flags)

```
 Google OIDC ──► auth/ {google, tokens, workspaces, invites, resolver=keyring}
 (relying party)        │        ▲ principals, team_memberships, acl_grants, invites, sessions
                        │        └── [GAP: these identity tables need workspace_id + RLS + enum test]
                        ▼ builds OperationContext{principal, workspaceId, grants[]}  (FAIL-CLOSED, throws)
 web/{chat,admin} ─► /api/:op ─┐
 agent (MCP) ······► /mcp ?? ──┤  [GAP: MCP transport never milestoned — only REST ships]
                               ▼
      dispatch: validate(zod) → ctx → RBAC(role) → run → redact-log   [port OperationError taxonomy]
                               ▼
      operations.ts (ops-as-data; workspace_id + grants[] = COMPILER-REQUIRED params)
             ├──────────────┬───────────────────┬───────────────
             ▼              ▼                    ▼
        ingest/import   search/hybrid        answer/answer
        (waist: stamp   (acl && grants IN    (retrieve → router → cite)
         ws/scope/acl    the ENGINE query,        │   [port Answer/Conflicts/Gaps + confidence]
         /owner; +chunks 3 return paths)          ▼
         +tags +links)       │              ai/router.ts (OpenRouter/ZDR, AsyncLocalStorage/ws)
             │               ▼                    │   [GAP: per-ws spend cap deferred to M8 → pull to M5]
             ▼          db/client (postgres.js, NON-BYPASSRLS role)
             │   per-request tx: SET LOCAL app.workspace / app.grants
             │   [GAP: tx must NOT wrap the model call → pool exhaustion (#1794)]
             ▼
   Postgres16 + pgvector   RLS policies: workspace-eq [pull to M0/M2?] + acl&&grants [M4]
   pages ┬ content_chunks ┬ tags ┬ links   (all carry workspace_id/scope/acl/owner)
         └ HNSW(embedding)  [GAP: filtered-HNSW recall collapse at tenant scale]
```

## Leak-canary / test-coverage map

| Test | What it proves | Plan status |
|---|---|---|
| Cross-tenant (A vs B, different workspaces) | no bleed in results/citations/counts | M3 — **also stub at M2** |
| Intra-workspace private (2 principals SAME ws, 1 private note) | acl&&grants actually filters | **MISSING → add** |
| Buggy-query (raw `SELECT *` via app role) | RLS backstop works | M4 |
| Identity-table enumeration (A can't list/count B's invites/principals/memberships) | no user/token enumeration | **MISSING → add** |
| GUC-bleed concurrency (2 tenants, `max=1` pool) | tx-local GUC doesn't leak across pooled conns | **MISSING → add** |
| Filtered-HNSW recall (1 big noisy tenant + 1 small) | small tenant still gets full top-k | **MISSING → add** |
| Pool-headroom (N concurrent answers mid-generation) | tx doesn't hold conn across model call | **MISSING → add** |
| Registry-parameterized canary | auto-covers every new op | **MISSING → add** |

## Failure-modes registry

| Mode | Trigger | Blast radius | Mitigation | Status |
|---|---|---|---|---|
| Cross-tenant read via forgotten filter | new op omits scope, M2→M4 window | ALL tenants | pull workspace-eq RLS to M0/M2 | **OPEN → user challenge UC3** |
| Intra-workspace private leak | op omits `acl&&grants` pre-M4 | same-ws members | compiler-required grants param + same-ws canary | AUTO-ADOPTED (A9) |
| GUC bleed across pooled conns | non-LOCAL `SET` / prepared-stmt cache | next tenant on backend | tx-local `set_config(...,true)`, `prepare:false`, bleed test | AUTO-ADOPTED (A11) |
| Pool exhaustion (#1794) | tx wraps LLM call | all requests wedge | tx around DB work only | AUTO-ADOPTED (A8) |
| Filtered-HNSW recall collapse | selective ws filter on global index | small tenants get too-few/zero results | pgvector≥0.8 iterative_scan; recall test; partition escalation | AUTO-ADOPTED (A7) |
| Identity-table enumeration | invites/principals lack RLS | cross-tenant PII/tokens | columns+RLS on identity tables + enum test | AUTO-ADOPTED (A10) |
| Unbounded tenant spend | shared key, caps at M8 | founder budget mid-demo | pull per-ws fail-closed cap to M5 | AUTO-ADOPTED (A15) |
| Gmail founder can't bootstrap | blocklist gates workspace CREATE | target market locked out | decouple create vs auto-join | AUTO-ADOPTED (A13) |
| Invite dead-end | Gmail dot/+/case normalization | onboarding | match on verified-email/sub + normalize | AUTO-ADOPTED (A14) |

## DX scorecard

time-to-value **5** · onboarding-friction **4** · error-actionability **5** · ops-observability **4** · agent-surface-readiness **3** · upgrade-safety **8**.

## Decision Audit Trail (auto-decided via the 6 principles)

| # | Lens | Decision | Class | Principle | Rationale |
|---|---|---|---|---|---|
| A1 | Design | Port gbrain's Answer/Conflicts/Gaps + confidence + citation IA (numbered chips + source panel w/ scope badge) into the answer surface | mechanical | P4 DRY, P1 | reuse a built, leak-canary-protected asset; citations alone = generic chatbot |
| A2 | Design | Enumerate all 6 UI states per surface; add partial-visibility banner + permission-denied + stale/revoked-citation | mechanical | P1 | states are the tenant-defining moments |
| A3 | Design/CEO | First-run cold-start: seed/sample questions on empty brain + guided first-upload + "activate: invite N / add M docs" | mechanical | P1 | multiplayer aha can't fire on an empty slice |
| A4 | Design | Rename "Private\|Everyone" → "Only me"/"Everyone at {Workspace}", show resolved audience, design a scope menu that grows to teams | mechanical | P5 | "Everyone" reads as public; binary breaks when teams land same milestone |
| A5 | Design | Lightweight design system (tokens/type/spacing) + 1-page voice guide before M5 | mechanical | P1 | many net-new surfaces need one system |
| A6 | Design | Spec invite lifecycle states (sent/pending/accepted/expired/revoked) + member-roster IA | mechanical | P1 | tenant-management essentials |
| A7 | Eng | Require pgvector ≥ 0.8 + `hnsw.iterative_scan`; decide in M0; add skewed-tenant recall test; document hash-partition escalation | mechanical | P1 | recall collapse is a real multi-tenant failure; gates M0 schema |
| A8 | Eng | Scope the RLS/GUC tx to DB work ONLY, never around the model call; refine Invariant 3; add pool-headroom load test | mechanical | P5 | avoids gbrain's #1794 pool exhaustion |
| A9 | Eng | Make `grants[]`/acl a compiler-required engine param (fail-closed by compiler); add same-workspace private-note canary case | mechanical | P5 | closes intra-ws private leak pre-M4 |
| A10 | Eng | Extend columns-day-0 + RLS to identity tables (principals/memberships/invites/sessions); add enumeration test | mechanical | P1 | prime cross-tenant enumeration surface, no gbrain port exists |
| A11 | Eng | Enforce GUC discipline: lint-ban non-LOCAL GUC writes; `prepare:false` behind pooler; GUC-bleed concurrency test | mechanical | P5 | asserted but untested = the actual pooler failure mode |
| A12 | Eng | Document single-global-`vector(N)` constraint in DECISIONS.md; reserve multi-column/per-tenant-model pattern | mechanical | P1 | one dim = fleet-wide re-embed forever otherwise |
| A13 | DX | Decouple workspace CREATE (any verified login → personal ws) from domain AUTO-JOIN (blocklist blocks auto-join only) | mechanical | P5 | current rule locks out Gmail-first target market |
| A14 | DX | Match invites on Google verified-email/sub + normalize Gmail (dots/+/case) + explicit "invite is for X, you're Y" error | mechanical | P1 | silent no-match dead-ends in a Gmail-heavy market |
| A15 | DX | Pull a per-workspace fail-closed spend cap to M5 (port `withBudgetTracker`) | mechanical | P2 | unbounded tenant spend on a shared key through the external demo |
| A16 | DX | Port `OperationError` taxonomy at M1 + auth code set (unauthenticated/no_workspace/no_grant/insufficient_role, each w/ suggestion+docs) | mechanical | P4 | permission errors are the #1 multi-tenant support surface |
| A17 | DX/CEO | Single-workspace brain-loop spike before/alongside M2 (hardcode resolver output) to validate answer quality ~wk2; columns stay day-0 | mechanical | P2 | prove the core bet cheaply before 1.5wk of identity |
| A18 | CEO | Keep the reranker seam in v0 (`gateway.rerank` ports cheaply) + a small answer-quality eval set as a v0 exit criterion | mechanical | P1 | the pitch rests on demo answer quality; don't strip to recursive-only blind |
| A19 | DX | Minimal per-workspace ops panel in M5 admin (doc/chunk counts, period spend, last ingest, doctor summary) | mechanical | P2 | operator paying the bill has zero visibility otherwise |
| A20 | DX | Land a minimal 2-tenant leak-canary stub at M2 (as soon as workspaces exist); expand to full canary at M3 | mechanical | P1 | cross-tenant bugs live in M1/M2 code |
| A21 | CEO | Re-baseline v0 to ~11-13 weeks honest (or explicitly cut pooled scope); add a week-3 re-plan checkpoint on M0-M2 actuals | mechanical | P6 | "lose scope not schedule" can't fire on the sacred items |

## Open decisions for you (NOT auto-decided)

### User challenges — models disagree with a stated direction (your direction is the default)

- **UC1 — Silo-first vs Pool-now (challenges Locked Decision #1).** You said "multi-tenant from row zero, non-negotiable in M0." The CEO voice: for a demo + 2-3 design partners, ship **one gbrain-per-tenant (silo)** behind a thin hosted login shell, reuse gbrain's already-leak-tested company-brain, and add `workspace_id`+RLS only when a design partner needs a shared DB. **Cost if the challenge is right and you pool anyway:** ~40% of v0 (M0 columns + M4 RLS + much of M2) spent on tenant plumbing before any user validates the product; silo→pool later is a known bounded migration. **Cost if you silo and the challenge is wrong:** per-tenant ops overhead, and a shared-corpus feature forces the pool migration sooner. → **gate**
- **UC2 — Port patterns vs Fork gbrain (challenges the "port, don't fork" guardrail).** Hand-porting a v0.42, ~47-op engine loses every bug fix in gbrain's history and multiplies build time on the *least-differentiating* layer. Recommend **fork-and-narrow** (keep the engine, replace source-scope with your identity/tenancy seams) or vendor gbrain as a library. → **gate**
- **UC3 — Pull workspace-equality RLS forward to M0/M2 (challenges the M4 enforcement timeline).** M2 already creates real workspaces/principals/invites; between M2 and M4 the only thing between tenants is app code. The non-BYPASSRLS role + GUC plumbing are already day-0, so `USING workspace_id = current_setting('app.workspace')::uuid` is nearly free to start early; leave only `acl && grants` refinement at M4. **Recommend accept** — it strengthens your own "never leak" value. → **gate**
- **UC4 — Add a thin MCP transport to v0 (challenges v0 scope).** The product identity is "the brain layer for your AI agent," but v0 ships only `/api/:op`; agents speak MCP. The M1 dispatch spine + ParamDef→JSON-Schema already produce MCP-shaped tool defs, so `tools/list`+`tools/call` over stdio (later `/mcp` HTTP with per-ws token→grants) is cheap. **Recommend accept.** → **gate**
- **UC5 — Default scope: private vs workspace (challenges M3 "default = private").** A shared brain whose "Everyone" corpus starts empty (because every upload defaults private) feels dead at the exact demo moment. Options: workspace-default + prominent privacy toggle, OR keep private-default + a forceful post-upload "share with your team?" nudge. **Do not ship private-default alone.** → **gate**
- **UC6 — Gate M0 on discovery + a sharp vertical (challenges "discovery in parallel with code").** Building 7-8 solo weeks in parallel with discovery commits before you know the ICP, willingness-to-pay vs "just use Gemini," and the vertical. The v0 wedge is GTM-only; a specific India vertical (e.g. the hinted CA/accounting pack) is something Google won't build. → **gate**

### Taste decisions — reasonable people disagree (recommendation given; you can override)

- **T1 — Managed auth (WorkOS/Clerk/Auth.js) vs roll-your-own OIDC for v0.** Recommend **managed** for v0 (auth is highest-blast-radius, lowest-differentiation for a solo founder; a mistake is a cross-tenant breach); keep only the keyring/grants resolver net-new. Defensible to self-host if India data-residency makes a third-party auth vendor a dealbreaker.
- **T2 — Embedding provider/dim lock (semi-irreversible, gates M0 schema).** Recommend **OpenAI `text-embedding-3-small` 1536d** (documented ZDR, ecosystem portability) over ZeroEntropy `zembed-1` 1280d (cheaper). Record the single-global-dim constraint (A12).
- **T3 — HNSW under tenant scale:** global index + pgvector-0.8 iterative_scan (recommend now) vs hash-partition by `workspace_id` (escalate when a noisy tenant degrades others). Decide the **pgvector version floor now** (gates M0).
- **T4 — ZDR default vs per-workspace toggle.** Recommend keep the single-door router seam, default the cheapest/fastest provider for the demo, make ZDR a per-workspace toggle you flip when procurement asks. (Minor; you chose ZDR-default in Decision #6.)
- **T5 — One visual system vs two:** recommend **two** (warmer member-facing chat/upload; inherit gbrain's dark operator look for `/admin` only).

## Cross-phase themes (flagged independently by ≥2 lenses)

- **"Identity/tenancy is front-loaded before the core bet is validated"** — CEO (findings 1-2) + DX (finding 6) + the A17 spike. High-confidence signal: prove the ported answer loop on a real messy corpus early.
- **"The under-scoped layer is the user-facing/agent-facing surface, not the tenancy layer"** — Design (whole review) + DX (agent-surface 3). The plan's rigor is all in the DB; the demo lives or dies on surfaces the plan gives one paragraph.

## GSTACK REVIEW REPORT

- **Status:** DONE_WITH_CONCERNS. The tenancy/security core is sound and the gbrain port is accurately scoped (Eng port-accuracy 9/10). **2 architecture gaps** (filtered-HNSW recall; RLS-tx-around-LLM) and a **cross-tenant M2→M4 window** are auto-adopted fixes (A7, A8, UC3). The **product-design + agent surfaces** are under-scoped (auto-adopted A1-A6) and **strategy/sequencing** has 6 open user challenges.
- **Codex:** `[codex-unavailable — usage limit]`; single-voice run, gbrain claims re-verified by the Eng voice against source.
- **Auto-adopted:** 21 amendments (A1-A21) folded in above — apply these into the milestone sections when the plan is next revised.
- **Awaiting your call:** 6 user challenges (UC1-UC6) + 5 taste decisions (T1-T5) at the gate below.
- **Next:** on your gate answers, I revise the plan (fold A1-A21 + your UC/T choices into M0-M5), then produce the execution-ready M0 code plan.

## Post-review resolution (2026-07-23) — gate answers applied

**Confirmed by the founder at the gate:**

1. **Tenancy = Pool + RLS from row zero** (Locked Decision #1 reaffirmed). Because we are pooling, every eng safety pull stays mandatory: **UC3** (pull bare `workspace_id`-equality RLS + GUC tx to M0/M2, leave `acl && grants` at M4) is **ACCEPTED and applied**; A7 (pgvector ≥ 0.8 iterative-scan), A9 (compiler-required `grants[]`), A10 (identity-table RLS + enumeration test), A11 (GUC-bleed discipline) are all in force.
2. **Build approach = Fork gbrain, delete-down to the SaaS seams** (fork-and-narrow). **Supersedes** the old guardrail "Port patterns, don't fork." MIT obligation: keep gbrain's copyright + MIT text in a `NOTICE`/`LICENSE-gbrain` file; company-brain stays closed-source, proprietary, and commercial. Net-new code is reserved for the identity/tenancy seams; the engine (chunkers, RRF search, dedup, queue, gateway, link-extraction) is inherited, not re-derived. This changes M1/M3 from "reimplement" to "keep + reseam" and lowers M3 schedule risk.
3. **Identity = Roll-your-own Google OIDC** (M2 reaffirmed; defensible for the India data-residency pitch). Because this is the highest-blast-radius net-new area, A16 (OperationError + auth code taxonomy), A20 (2-tenant canary stub the moment workspaces exist), and A10 (identity-table RLS + enumeration test) are non-negotiable here.
4. **Agent surface = Add a thin MCP transport to v0** (**UC4 accepted**). stdio `tools/list`+`tools/call` reusing the M1 dispatch spine; `/mcp` HTTP with per-workspace token→grants after. Added to M3's done-when + a zod→JSON-Schema step for `inputSchema`.

**Applying (non-gated recommendations; founder can override):** UC5 default scope = **workspace-default + prominent privacy toggle** OR **private + forced post-upload share-nudge** — never private-alone (flagged for the founder's product call); T2 embeddings = **OpenAI `text-embedding-3-small` 1536d**; T3 = **pgvector ≥ 0.8 floor** (gates M0 schema); T5 = **two visual systems** (warm member chat, dark `/admin`).

**Founder's to run (not a build task):** UC6 — the 5-10 discovery conversations + a sharp India vertical wedge, ideally gating the start of M0.

**Net effect on the plan:** pooled multi-tenancy stays, but v0 is now (a) built on a **forked** gbrain engine, (b) hardened earlier (workspace-eq RLS at M0/M2, not M4), (c) shipping an **MCP transport** and a real **design layer** (answer contract + states + cold-start), and (d) honestly re-baselined toward ~11-13 weeks. Next artifact: the execution-ready **M0 code plan** reflecting the fork-and-narrow approach.
