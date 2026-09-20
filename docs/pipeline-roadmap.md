# Ingestion & retrieval pipeline roadmap — M6+

## Context

`docs/plan.md` and `docs/screens.md` cover M0–M5b; neither covers what comes after. This document
does. It exists because a comparative read of gbrain (Garry Tan's single-tenant reference
implementation, MIT, `~/dev/gbrain`, 761 source files / 41 tables) against company-brain's current
ingestion path (~50 source files / 14 tables, DB verified) found company-brain implements the first
stage of gbrain's pipeline — extract, chunk, embed, store — and stops. gbrain keeps deriving
structure after the write: 18 recurring enrichment phases (links, facts, takes, concepts, timeline,
salience) plus staleness tracking that decides what to revisit. `pages.compiled_truth` is the visible
symptom: the column exists (ported from gbrain's schema) and nothing writes it, because the cycle
engine that would populate it was never built.

**The tax gbrain never paid.** gbrain is single-tenant — no `workspace_id`, no RLS, app-enforced
isolation only. Every table below needs `workspace_id` + `acl`, an RLS policy, a composite FK to
keep tenancy in sync, per-column grants snapshotted in the doctor fixture (`test/fixtures/
expected-column-grants.json`), and leak-canary coverage. Budget **~30–40% overhead per table**
against gbrain's own build time for this reason — it is the cost of the moat, not waste, and every
size estimate below already includes it.

**Sizing convention:** human-team weeks / CC-assisted, where CC-assisted assumes the same review
discipline used to land `MAX_PER_PAGE` this session (measure before building, oracle-test before
trusting, verify live before shipping) — not raw generation speed.

**What this is not:** a commitment to build all of it, or in this order past M9. It is the map. See
"What to actually build" at the end for the compressed recommendation.

---

## M6 — Document identity & the metadata plane

**Status: already scoped and founder-approved** — this is the metadata plane deferred at the
`/autoplan` gate during the MultiHop recall work (`the-recall-is-shit-robust-hanrahan.md`,
"deferred, NOT cancelled"). Nothing below it should start first; `effective_date` is a dependency
of M7's recency lever and M9's staleness signal.

| Ship | Why it's foundational | gbrain reference |
| --- | --- | --- |
| `effective_date` + `effective_date_source` | One temporal field however derived; the provenance sentinel keeps a derived date auditable across heterogeneous sources | `pages.effective_date`, doctor health check on the source field |
| `author`, `metadata` JSONB | Typed columns only for what is filtered on; JSONB bag for the rest | `pages.frontmatter` |
| `content_hash` | Change detection — without it, re-sync re-embeds everything unconditionally | `pages.content_hash` |
| `chunker_version` | Lets a chunker change trigger a targeted re-chunk instead of a blind full rebuild | `content_chunks` version column + post-upgrade sweep |
| `deleted_at` + purge phase | Soft delete with a recovery window. **Must land before M9's derived tables**, or every enrichment phase orphans silently on a hard delete | `pages.deleted_at`, 72h purge cycle phase |
| `since`/`until`/`author` filters on `search`/`ask` | The actual product capability — "what did we decide last quarter" | — |

**Deferred here on purpose, not smuggled back in:** recency-as-a-ranking-signal (M7's job, and it
needs sweep evidence first) and any filter *extraction from question text* — the MultiHop harness
proved that route tempts building a shim tuned to one dataset's vocabulary rather than a real
product capability.

**Exit criteria:**
- `bun run call search '{"query":"x","since":"2026-04-01"}'` returns filtered results.
- `bun run explain:search` still shows `idx_chunks_tsv` in the plan — the new columns are
  correlated with `acl`/`workspace_id` in the same way that caused the 4.6s regression this
  session fixed, and the check that would have caught it stayed in the loop.
- `bun run doctor --update && git diff test/fixtures/expected-column-grants.json` shows only the
  new columns, only for `cb_app`.

**Size:** 2–3 weeks / 3–5 days.

---

## M7 — Retrieval intelligence

**Depends on M6** (recency needs `effective_date`).

**Status (2026-09-20): implemented and measured; baseline retained.** The commit-pinned behavioral
port, one-statement SQL integration, typed policy resolver, nine-profile held-out sweep, and NovaByte
comparator are built. The completed plain MultiHop sweep selected `gbrain-intent` on tuning but its
untouched-holdout gate failed (0.44pp mean recall@8 lift, adjusted p=1), so
`DEFAULT_RETRIEVAL_KNOBS` intentionally continues to alias the exact baseline profile. NovaByte was
not run: a failed retrieval gate already rules out promotion.

| Ship | Evidence this is worth building |
| --- | --- |
| Injectable knobs (`RetrievalKnobs` on `hybridSearch`) | Implemented as one deeply immutable policy, with validated server-wide JSON and trusted internal per-call overrides. Public HTTP/MCP schemas do not expose it. |
| Intent classifier + per-intent fusion weights | **Measured on the full 2,255-question MultiHop run:** `inference_query` scores 22.8% vs `comparison_query` 51.9% at k=8 (n=816 vs n=856). A 29-point gap is exactly what gbrain's `entity` intent (`keywordWeight 1.15`, `exactMatchBoost 1.25`) targets — "who is X" lookups should lean keyword, not vector. |
| Recency decay, **shipped OFF by default** | Implemented with M6 `effective_date`, a frozen evaluation clock, and off/auto/on/strong modes. Null dates are neutral and future dates clamp to age zero. |
| `eval:sweep` with a held-out split | Implemented with a joint type × required-document-count split, immutable resume contract, nine registered profiles, per-hop/type/intent reporting, and a paired-bootstrap/Bonferroni promotion gate. The latest completed run failed its gate, so baseline remains selected. |

**Exit criteria:** the full provider-backed sweep reports all nine configurations; the untouched
holdout gate passes; the actual MultiHop query plan preserves the stored FTS/GIN and HNSW paths plus
the lateral hydration fence; and the strict NovaByte baseline/candidate comparison passes. Only then
may `DEFAULT_RETRIEVAL_KNOBS` change. The latest completed sweep did not pass, so a future promotion
attempt needs a new preregistered run. See `docs/eval-rag.md`; D110/D113 record the boundary.

**Size:** 2 weeks / 2–4 days. The initial tuning signal did not survive its holdout gate; further work
must improve the retrieval inputs or corpus representation rather than treat that tuning number as a
shipping decision.

---

## M8 — The cycle engine

The infrastructure every enrichment phase in M9–M10 needs. Build once, deliberately, or build it
eight times badly inside eight separate phase scripts.

**Status (2026-09-18): implemented and live-verified — the exit criterion passes for real.** Built
ahead of this section's own recommendation below (the founder chose to; see D111 for the full
rationale, including why "advisory locks" below became a row-based lock table instead — `appSql()`'s
transaction pooler makes a session-scoped `pg_advisory_lock` unsafe here, the same reason gbrain's own
reference implementation uses a row-based table rather than the Postgres primitive its name suggests).
Typecheck and the offline suite are clean; migration `0020` is applied to the shared Supabase project;
`doctor` is 82/82 with the fixture diff reviewed as a security change; both live suites pass, including
`test/cycle-kill9.live.test.ts` — a real `kill -9` against a real subprocess, a real crash-recovered
lock reclaim, a real resumed-not-restarted checkpoint. Two more real bugs (jsonb double-encoding on
write; the lock's ~60s unconditional reclaim floor) surfaced only by running against the database —
see D111 and `HANDOVER.md`'s "Milestone 8" section for the full account.

| Ship | gbrain reference |
| --- | --- |
| Phase runner + base class | `cycle.ts` (2,505 lines), `cycle/base-phase.ts` |
| Advisory locks (one cycle run at a time per workspace) | `gbrain_cycle_locks` |
| Budget metering per phase | `cycle/budget-meter.ts` — enrichment is unbounded LLM spend without a ceiling |
| Checkpoint/resume | `op_checkpoints` |
| Ingest audit log | `ingest_log` |
| Failure ledger | `sync-failure-ledger.ts` |

**Exit criteria:** a no-op phase runs on a schedule, takes a workspace-scoped advisory lock,
respects a budget ceiling, checkpoints its progress, and resumes correctly after a `kill -9`
mid-run.

**Size:** 3 weeks / 1 week. Unglamorous, non-negotiable, and worth resisting the temptation to
skip — it is the difference between "18 phases" and "18 cron scripts that race each other and
retry from zero on every crash."

---

## M9 — Derived knowledge, wave 1

**Depends on M8.** Best value-to-effort ratio of the enrichment phases.

**Status (2026-09-20): link extraction shipped, review-hardened, and measured; fact extraction
deliberately deferred.** The exit criteria below name only link extraction. The completed graph-only
profile scored 38.68% all-evidence recall@8 versus baseline 38.76% on tuning, with two errored rows,
so it is neither a candidate nor a promotion. The feature remains default-off. gbrain's fact system
is a separate subsystem (bi-temporal versioning, per-write LLM calls, embedding dedup), and the
founder chose not to smuggle that scope into this milestone. D112/D113 and `HANDOVER.md` record the
security hardening, operational verification, and final evaluation result.

| Ship | Why first |
| --- | --- |
| **Link extraction + backlinks** (`links` table) | **The single highest-leverage phase for the measured problem.** Multi-hop questions need documents that relate to each other; explicit edges make that structural — a graph traversal — rather than something the ranker has to rediscover per query from embeddings alone. |
| Fact extraction | Independently useful for direct lookups; also the raw material `compiled_truth` synthesis (M10) consumes. **Deferred — see status line above.** |

**Exit criteria:** backlinks populate on ingest; a link-aware retrieval variant (e.g. one-hop graph
expansion before fusion) runs through the M7 sweep harness and is measured, not assumed.

**Size:** 3 weeks / 1 week.

---

## M10 — Derived knowledge, wave 2

**Depends on M9.**

Takes + grading (`take_proposals`, `take_grade_cache`), concept synthesis, **`compiled_truth`
generation** — the column already exists in `pages`, ported from gbrain's schema, and nothing
writes it; this is the phase that would — `emotional_weight` salience, timeline entries.

**Exit criteria:** `compiled_truth` is populated for a real corpus and measurably earns its
retrieval boost through the M7 sweep; salience is computed and is itself a sweepable knob.

**Size:** 5–6 weeks / 2 weeks. The largest LLM spend of any milestone here — M8's budget meter is
what makes running this safe rather than a surprise bill.

---

## M11 — Ingestion breadth

**Independent of M8–M10** — can run in parallel with those if resourced separately.

Source registry + `sources` table, file watcher daemon, inbox-folder ingest, git-diff-driven sync
(`buildSyncManifest` — only changed files touched), directory pruning + glob strategy,
`unsyncableReason()` diagnostics (why a file was skipped, not just that it was), CJK-aware slugs.

**Exit criteria:** dropping a file into a watched folder makes it searchable within seconds; `sync`
against a 1,000-file repo touches only the files that changed since the last run.

**Size:** 4 weeks / 1.5 weeks.

---

## M12 — Embedding maturity

Stale-chunk detection, a single skip-predicate source of truth, credential preflight (fail fast at
sync time, not mid-batch), embedding-dimension-mismatch guard, `embedded_at`/`model` stamped per
chunk, an async backfill queue, and **contextual retrieval** — Anthropic's published method of
prefixing each chunk with an LLM-generated synopsis of its place in the document before embedding,
built as a two-phase commit (collect all synopses in memory, restart the whole page at a lower tier
on any failure, only then write) so a page never lands half-updated.

**Exit criteria:** a chunker version bump triggers a *costed* re-embed prompt instead of a silent
full rebuild; contextual retrieval is A/B'd through the M7 sweep rather than assumed to help.

**Size:** 3 weeks / 1 week. Contextual retrieval alone is a documented double-digit recall
improvement in Anthropic's own published results — worth pulling forward if M7's sweep
underdelivers on its own.

---

## M13 — Code intelligence

Tree-sitter WASM chunker (36 language grammars), symbol-level chunk metadata (`symbol_name`,
`symbol_type`, `start_line`, `end_line`, `parent_symbol_path`), code-edge graph
(`code_edges_chunk`, `code_edges_symbol`), qualified-name resolution.

**Size:** 5 weeks / 2 weeks.

**Recommend cutting or deferring indefinitely.** gbrain is a code-and-knowledge brain built for an
individual engineer; company-brain is a *company* knowledge brain — contracts, meetings, policies,
decks. Unless customers are specifically engineering orgs indexing their own repositories, this is
the largest milestone in the roadmap serving the smallest slice of the actual user base. Revisit
only if a design partner asks for it by name.

---

## M14 — Multimodal

Image ingest, OCR, EXIF metadata extraction, `embedding_image` / `embedding_multimodal` / `modality`
columns.

**Size:** 3 weeks / 1 week. Genuinely relevant for company documents — scanned contracts, a
whiteboard photo from a meeting, a screenshot embedded in a deck — and arguably a better use of a
week than M13.

---

## Total, and what it means against v0

~30 weeks human-team / ~10–12 weeks CC-assisted, excluding M13. That is a full quarter-plus of
solo work, and every hour of it is M6 or later.

**M5b — teams, member/operator admin, conversations, MCP-over-HTTP — has not started.** It is the
remainder of v0 (`CONTEXT.md`: "M5b not started; see docs/screens.md"). Building this roadmap first
means shipping a system with strong retrieval that a customer's team cannot be invited into. The
same regret scenario a prior review named still applies here: the first real complaint is far more
likely to be "I can't add my colleague" than "recall is 40% instead of 55%."

## What to actually build

If the goal is the pipeline's value without the full quarter: **M6 + M7 + M9** is roughly 20% of
the list and carries most of its structural value, at ~2 weeks CC-assisted. Metadata unlocks filters
customers already want; the first intent and graph sweeps did **not** produce a promotable lift, so
the next evidence-backed lever is better corpus representation rather than turning ranking knobs on.
Link extraction still creates the substrate M10 needs, and M8 now has a real phase consumer rather
than only no-op proof machinery.

M5b competes with all of this for the same weeks. That tradeoff is a founder call, not an
engineering one, and this document does not make it.
