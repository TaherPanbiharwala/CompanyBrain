# RAG evaluation harness

Measures whether retrieval finds the right documents, and whether the model invents answers when the
corpus has none. Runs against any benchmark that has a **dataset adapter**; MultiHop-RAG is the first.

Before this existed there were two eval harnesses (`eval:a17`, 10 questions; `eval:novabyte`, a
security/tenancy suite) and neither appeared in the README, so the discovery path was reading
`package.json`. This document is the fix for that.

---

## Quick start

```bash
eval "$(bun run --silent seed:eval --dataset multihop)"
```

```bash
bun run load:eval --dataset multihop
```

```bash
bun run eval:rag --dataset multihop --dry-run
```

```bash
bun run eval:rag --dataset multihop
```

Measured on the MultiHop corpus (609 documents, ~2,830 chunks per workspace), concurrency 4:

| Step | Time | Cost |
| --- | --- | --- |
| `seed:eval` | seconds | free |
| `load:eval` | ~5 min per workspace (~1.9 docs/s) | ~$0.035 per workspace (~$0.07 total) |
| `eval:rag` (retrieval, 2,255 q × 2 variants) | **~1 hour** | ~$0.05 — query embeddings only, **no chat calls** |
| `eval:rag --sample 400` | ~10 min | ~$0.01 |
| `eval:rag --nulls` | ~10 min | ~$2 for 301 questions |

**Wall clock, not money, is the binding constraint.** `hybridSearch` measures **4,645ms median** on a
2,844-chunk workspace — 42× a single pooler round trip, and 101% of the cost of a whole `ask`. That
is a product concern in its own right (every question waits ~4.6s before the model starts) and it was
invisible until now because the A17 corpus is 14 chunks. Use `--sample` while iterating; the full
sweep is an hour.

---

## Which numbers you can trust

**This is the part that matters most.** Not every metric this dataset can produce is meaningful.

| Metric | Trustworthy? | Why |
| --- | --- | --- |
| **Retrieval** (all-evidence-recall, MRR, candidate-recall) | **Yes** | Never calls the chat model. Structurally immune to what the model already knows. |
| **Abstention on unanswerable questions** | **Yes** | A memory-driven answer to a question the corpus cannot answer *is* the defect being hunted. |
| **Answer correctness** | **NOT MEASURED, deliberately** | See below. |

MultiHop-RAG is public news from Sept–Dec 2023 and `CHAT_MODEL` is a 2026 web-trained model. Gold
answers are dominated by `Sam Bankman-Fried` (271), `Google` (211), `Sam Altman` (56), and there are
only **107 distinct answers across 2,255 answerable questions** — a constant "Sam Bankman-Fried"
baseline scores ~12%. A correct answer may have come from the model's memory rather than from your
retrieval, and nothing in the output can tell the two apart.

So answer correctness is not scored here at all. It belongs on a corpus no model has memorized — the
NovaByte dataset — which is what [D15](../DECISIONS.md) actually asked for.

### The constraint, and what replaced it (2026-08-09)

This document previously carried a blanket rule: *no number from this harness may justify a change to
`src/search/hybrid.ts`, chunking, or the prompt* — on the reasoning that every question here is
multi-hop while real traffic is mostly single-hop, so the benchmark would score a regression as an
improvement.

**The premise was assumed, never evidenced.** It originated in a plan review, not in observation. The
founder has since stated the opposite: real work does pull from several documents at once. So the
blanket rule is retired. What replaces it is narrower and matches what this harness can actually
see:

> **Retrieval numbers here may justify a retrieval change. No number here may justify one on its own
> once ANSWER quality is at stake — that requires a corpus the model has not memorized.**

Two live examples of why the second half matters:

- **`all-evidence-recall` counts DOCUMENTS, not depth.** 63.3% of retrieved gold documents currently
  contribute more than one chunk to the top-8. Any change that trades within-document depth for
  document breadth scores *better* here while the metric is structurally blind to the cost.
- **Concretely:** `MAX_PER_PAGE = 1` measures **+13.8pp** on this benchmark. That is largely the
  metric rewarding the configuration that maximises document count by construction. `MAX_PER_PAGE = 2`
  measures **+3.3pp** (75 questions fixed, 0 broken) and is what shipped — deliberately, and below
  the 5pp threshold the run pre-registered, on the strength of the fixed/broken split rather than the
  aggregate. Neither has passed an answer-quality check.

---

## Metrics

| Metric | Meaning |
| --- | --- |
| **all-evidence-recall@k** | Every required document present within the first k chunks. The multi-hop bar, and the primary number. |
| **evidence-recall@k** | Fraction of required documents found. Partial credit shows how far off a failure is. |
| **hit@1 / MRR** | Position of the first required document. Comparable with the existing a17 numbers. |
| **distinct-docs-in-context** | Unique documents the k chunks span. `MAX_PER_PAGE = 3` floors this at ⌈k/3⌉. |
| **candidate-recall** | Required documents present anywhere in the ~60-chunk **pre-fusion** pool. |

### Reading the k-curve — three causes, not two

Every arm is capped independently of `topK`: `ARM_LIMIT` 20 (vector), `KW_AND_SLOTS` 20,
`KW_OR_SLOTS` 10, `TITLE_LIMIT` 10. **Fusion never sees more than ~60 candidates at any k.** `topK`
controls how many survive fusion, not how many enter it.

| Observation | Cause | Fix |
| --- | --- | --- |
| Recall climbs with k | Budget — good chunks ranked below the cutoff | Raise `topK` |
| Recall flat, candidate-recall **high** | Ranking — the chunk was found and ranked badly | Reranker, embeddings, weights. Costs money. |
| Recall flat, candidate-recall **low** | **Arm-limit starvation** — the chunk never entered the pool | Raise the arm limits. Free, DB-side. Reranking would not have helped. |

Without `candidate-recall`, rows 2 and 3 look identical and have opposite fixes.

### Why `k` stops at 20

`answerQuestion` calls `hybridSearch` with no opts, so it always uses `DEFAULT_TOP_K = 8`, and the
public `search` op caps `limit` at 20. Reporting recall@24 would produce a finding whose action item
nobody can take.

---

## plain vs meta — the metadata A/B

The corpus loads into **two** workspaces:

| Workspace | Body ingested |
| --- | --- |
| `<dataset> eval (plain)` | Document body verbatim — what `ingest` does today |
| `<dataset> eval (meta)` | `source \| author \| published_at` header, then the body |

Why: **92% of questions (2,342/2,556) name a news outlet**, but only **216/609 documents (35%)**
contain their own outlet name in the body. **583 questions reference dates**, and `ImportPageInput`
has no date field, so `published_at` is discarded at ingest. Retrieval reads
`content_chunks.content`, `content_chunks.embedding` and `pages.title` — **never `tags`**.

Without the meta variant, temporal questions score badly and the report reads "retrieval is weak on
time-based questions" when the real cause is "the loader never stored the dates". The **delta**
between the two runs is the finding: it sizes what the engine's missing metadata plane costs.

`chunkText` has no per-chunk header, so the header lands in chunk 0 only — which is also where the
title arm's `ord = 0` chunks come from, so two of the four arms can reach it.

---

## Flags

```
--dataset <name>         Benchmark. Default: multihop.
--dir <path>             Dataset location (also reads MULTIHOP_DIR).
--variant plain|meta     Score one variant. Default: both, with the delta table.
--sample <N>             Stratified subset, proportional across question types.
--sample-seed <N>        Default 42. Same seed -> same questions, so two runs are comparable.
--type <t>               One question type. The _query suffix is optional.
--nulls                  Hallucination tier. Uses the chat model at topK=8.
--dry-run                Resolve everything, print the manifest, spend nothing.
--resume <run-id>        Continue a checkpointed run.
--allow-paid-retrieval   Proceed when query expansion is on.
--help
```

`SMOKE=1` is an alias for `--sample 40` (the knob `novabyte-eval.ts` already uses).

`--sample` is **total**, stratified proportionally: `--sample 40` on MultiHop yields roughly 13
comparison, 13 inference, 9 temporal, 5 null. That last number is a warning — a 40-question sample
cannot say anything useful about abstention.

---

## Environment interactions that change what you are measuring

| Variable | Default | Effect if set |
| --- | --- | --- |
| `RERANK_MODEL` | `''` (off) | **The run refuses to start.** Reranking makes `fetchK = topK × 4`, so the top-8 of a pooled run is not a real k=8 run and the sweep would measure the reranker. |
| `QUERY_EXPANSION` | `0` (off) | **Refuses without `--allow-paid-retrieval`** — it makes a paid `chat()` call per question, so the "free" run becomes 2,556 paid calls. |
| `AUTOCUT_RATIO` | `0` | **Refuses if non-zero.** The harness slices one retrieval for all cutoffs; autocut runs *after* the topK slice, which invalidates that. |
| `FRONTIER_MODEL` | `''` | Unused here (no judge). Worth knowing: `chat()` falls through to `CHAT_MODEL` when it is empty, so a judge would silently *be* the model under test. |

---

## Failure recovery

**"corpus check: 0 of 609 documents found"** — the workspace is empty. Run `load:eval`. This check
exists because `all-evidence-recall = 0.00` otherwise has four indistinguishable causes: broken slug
join, corpus never loaded, partial load, or wrong workspace.

**"corpus check: 431 of 609 — 178 missing"** — a partial load. Re-run `load:eval`; it skips what is
already there and does **not** re-pay for those embeddings.

**"N of 609 documents produce an invalid slug"** — nothing was ingested and nothing spent. Three
MultiHop URLs exceed the 200-character cap, which is why `slugify` truncates to 187 and appends a
12-hex-character hash of the *full* id. Ids differing anywhere still get different slugs.

**"ABORTING: 10 consecutive questions retrieved with degraded=keyword_only"** — the embedding
provider is failing and `hybridSearch` silently falls back to keyword-only. Every number after that
point would measure keyword search alone while looking completely normal. Check `OPENAI_API_KEY`.
Partial rows are on disk; resume with the printed command.

**Interrupted run** — rows are checkpointed to `eval/runs/<dataset>-<runId>.jsonl` as each question
completes. Resume with `--resume <run-id>`.

**Mis-targeted load** — `bun run load:eval --purge --yes` deletes exactly that dataset's pages from
the target workspaces. It is the only clean undo; there is no bulk delete anywhere in
`src/api/operations.ts`.

---

## Shared-database side effects

`.github/workflows/ci.yml` states that dev, the eval harness and CI's `live` job share **one**
Supabase project. Loading ~2,829 chunks per workspace has three knock-on effects:

1. `test/perf-recall.test.ts` asserts an exact query plan, and its own comment predicts this:
   *"a production corpus … is where the planner crosses over."* It can flip with zero code change.
2. `eval/top8-baseline.txt` may drift — `hnsw.iterative_scan = relaxed_order` is approximately
   ordered over a now-larger graph.
3. `scripts/measure-a17.ts` picks the **largest tenant by chunk count**, so `measure:a17` silently
   starts measuring this corpus instead of A17.

Capture the baselines before and after, and put the delta in the report:

```bash
bun run dump:top8 > eval/pre-multihop-top8.txt && CB_RUN_PERF_TESTS=1 bun test test/perf-recall.test.ts
```

That turns an unmanaged risk into the most product-relevant measurement available here: **does a
large tenant degrade a small tenant's recall on this stack** — D58's latent cross-tenant scenario.

---

## Getting the dataset

Not vendored: third-party data with its own licence.

```bash
hf download yixuantt/MultiHopRAG --repo-type dataset --local-dir ~/Desktop/Datasets/MultiHopRAG
```

609 documents, 2,556 questions (comparison 856, inference 816, temporal 583, null 301), ~12MB,
licence ODC-BY. The loader also detects the HuggingFace snapshot layout (`<sha>/corpus.json`).

---

## Adding another dataset

Write one adapter and add one registry line. Nothing else changes.

```ts
// src/eval/adapters/mydataset.ts
export const myAdapter: DatasetAdapter = {
  name: 'mydataset',
  defaultDir: '…',
  acquisitionHint: 'how to obtain it',
  async load(dir) {
    return { docs: [...], questions: [...] };  // EvalDocument[] / EvalQuestion[]
  },
};
```

Then register it in `src/eval/adapters/index.ts`. `test/eval-harness.test.ts` runs its conformance
checks against every registered adapter automatically.

The internal shape is deliberately **BEIR-like** (`corpus` / `queries` / `qrels`), so NFCorpus, FiQA,
SciFact, HotpotQA and MS MARCO need a file-reading shim rather than a real translator.

A question with `goldDocIds: []` means **unanswerable** — that is what drives the hallucination tier,
so an adapter that cannot express it cannot use `--nulls`.

---

## Files

| Path | Role |
| --- | --- |
| `src/eval/types.ts` | The `EvalDocument` / `EvalQuestion` / `DatasetAdapter` contract |
| `src/eval/slug.ts` | `slugify` — the join key, shared by loader and scorer |
| `src/eval/core.ts` | Pure primitives: sampling, answer classes, abstention |
| `src/eval/adapters/` | Per-dataset translators + registry |
| `src/search/eval-score.ts` | `scoreMultiHop`, `scoreCandidateRecall` (additive to the a17 scorer) |
| `scripts/eval-common.ts` | Args, workspace state, the metadata header |
| `scripts/seed-eval-workspace.ts` | Creates the two workspaces |
| `scripts/load-eval-corpus.ts` | Ingests both variants |
| `scripts/run-rag-eval.ts` | The harness |
| `test/eval-harness.test.ts` | No DB, no network, no money |
