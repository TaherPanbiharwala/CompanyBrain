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

`load:eval` sends document chunks to the configured embedding provider. `eval:rag`, `eval:sweep`,
and the NovaByte evaluator send questions (and, for answers, retrieved evidence) to configured model
providers. Treat those as real data-egress and paid calls; obtain the appropriate approval before
running them on non-public or company data.

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
| **distinct-docs-in-context** | Unique documents the k chunks span. The baseline `maxPerPage = 2` floors this at ⌈k/2⌉. |
| **candidate-recall** | Required documents present anywhere in the ~60-chunk **pre-fusion** pool. |

### Reading the k-curve — three causes, not two

Every arm is capped independently of `topK` by the selected retrieval policy: baseline limits are
20 vector, 20 keyword-AND, 10 keyword-OR, and 10 title. **Fusion sees at most 60 baseline
candidates.** M7's SQL uses the larger of `fetchK × 4` and the sum of all arm limits as its bounded
post-fusion capacity, so every admitted candidate is eligible for exact/recency rescoring. `topK`
controls how many survive, not how many enter fusion.

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

## M7 held-out sweep and promotion gate

M7 is a behavioral port of gbrain retrieval intelligence pinned to commit
`8c70f6255047a7647adb30b1d6333a48068d9fa5`. It preserves Company Brain's RLS-scoped, one-statement
search and changes ranking only inside the bounded candidate pool. The selected code default remains
`BASELINE_RETRIEVAL_KNOBS` until both gates below pass.

The sweep is preregistered: seed 42; 70% tuning and 30% untouched holdout; joint stratification by
question type and required-document count; recency frozen to one day after the corpus's latest
publication date. Tuning runs exactly these profiles: `baseline`, `gbrain-exact-only`,
`gbrain-fusion-only`, `gbrain-intent`, `recency-auto-only`, `gbrain-intent-auto-recency`,
`gbrain-intent-recency-on`, and `gbrain-intent-recency-strong`. Only baseline and the tuning winner
may touch holdout.

```bash
# MultiHop corpus must already be loaded into the seeded plain workspace.
bun run eval:sweep --dataset multihop --variant plain

# Load NovaByte once, then reuse the verified corpus for both answer-pipeline runs.
DATASET=/path/to/novabyte-test-dataset bun run eval:novabyte:setup
DATASET=/path/to/novabyte-test-dataset bun run eval:novabyte --retrieval-profile baseline
DATASET=/path/to/novabyte-test-dataset bun run eval:novabyte --retrieval-profile candidate
bun run compare:novabyte --old eval/runs/novabyte-baseline.json \
  --new eval/runs/novabyte-candidate.json
```

Sweep rows checkpoint immediately under `eval/runs/`. Resume with `--resume <run-id>`; it refuses a
different dataset hash, split/ID hash, seed, schema, model, config definition, knob hash, or recency
clock. Ten consecutive keyword-only degradations or a sustained error rate abort rather than silently
shrinking the denominator. The winner needs a strictly positive Bonferroni-adjusted paired-bootstrap
holdout result, no significant type/hop/intent regression, p95 latency within 10% of baseline, and no
degraded or errored comparison rows. NovaByte additionally refuses any answer/citation/injection,
ACL, leak, hit@3, aggregate retrieval, dataset/model, or loaded-corpus regression.

The A17 top-eight comparator is now named `compare:a17-top8`; `score:top8` remains a compatibility
alias. It is not the NovaByte promotion gate.

---

## Environment interactions that change what you are measuring

| Variable | Default | Effect if set |
| --- | --- | --- |
| `RERANK_MODEL` | `''` (off) | **The run refuses to start.** Reranking makes `fetchK = topK × 4`, so the top-8 of a pooled run is not a real k=8 run and the sweep would measure the reranker. |
| `QUERY_EXPANSION` | `0` (off) | **Refuses without `--allow-paid-retrieval`** — it makes a paid `chat()` call per question, so the "free" run becomes 2,556 paid calls. |
| `CB_RETRIEVAL_KNOBS_JSON` | `{}` | Trusted server-wide partial policy override, validated at startup. Example: `{"recency":{"mode":"off"}}`. The ordinary pooled harness refuses a non-zero `fusion.autocutRatio`; M7's registered sweep supplies complete internal profiles and records their hashes. |
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

## The `singletopic` dataset

A second, much smaller benchmark: Kaggle's ["Single-Topic RAG Evaluation
Dataset"](https://www.kaggle.com/datasets/samuelmatsuoharris/single-topic-rag-evaluation-dataset).
20 documents (2,750-~212k chars each, unrelated topics — game wikis, an arXiv PDF, EU policy, a TV
transcript, cooking), 40 single-passage questions, 40 multi-passage questions, 40 no-answer
questions. Adapter: `src/eval/adapters/singletopic.ts`.

```bash
eval "$(bun run --silent seed:eval --dataset singletopic)"
bun run load:eval --dataset singletopic
bun run eval:rag --dataset singletopic --dry-run
bun run eval:rag --dataset singletopic
bun run eval:rag --dataset singletopic --nulls
```

**Read this before trusting a number from it:**

- **Every question has AT MOST ONE gold document.** "multi passage" here means the answer needs
  several passages of the SAME document, not several documents — there is no cross-document
  multi-hop in this corpus, unlike MultiHop. `distinct-docs-in-context` and `evidence-recall`
  degenerate to 0-or-1 and say nothing useful; **hit@k/MRR** (did retrieval surface the one right
  document at all) and **`--nulls`** (does the model abstain on the 40 questions with no answer in
  the corpus) are the metrics actually worth reading here.
- **Document 16** ("Stardew Valley: Version History", ~212k chars) exceeds the `ingest` op's
  `MAX_BODY_CHARS` (200,000) and is truncated to 195,000 chars by the adapter — pinned by
  `test/eval-harness.test.ts`. Its questions may score worse than the other 19 documents' purely
  because of where the cut lands, not because retrieval regressed.
- **This dataset is small.** 120 questions total, 40 per tier — enough for a real yes/no on "does
  abstention work at all," not enough to detect a small regression the way MultiHop's 2,556
  questions can. Treat a delta of a few questions as noise.
- Default location: `~/Desktop/RAGTest` (override with `--dir` or `SINGLETOPIC_DIR`). Not vendored,
  same as MultiHop — download it yourself from the Kaggle link above.

---

## Answer-correctness grading (`grade:answers`)

Everything above is retrieval-only or abstention-only — deliberately, per "Which numbers you can
trust" above. `scripts/grade-answers.ts` is the opt-in exception: it runs the real answer pipeline
(real chat calls) on every question and grades the answer correct / partial / incorrect against the
dataset's own gold text, using the chat model itself as judge (or `FRONTIER_MODEL`, if you've set
one — that avoids the model grading its own work, which `CHAT_MODEL`-as-judge cannot).

```bash
bun run grade:answers --dataset singletopic --dry-run
bun run grade:answers --dataset singletopic --sample 20   # cheap smoke test first
bun run grade:answers --dataset singletopic
```

Only use this on a corpus where memorization is implausible — `singletopic` qualifies (mostly
obscure blogs, wikis, and one private Dropbox doc); MultiHop does not (see its own header comment in
`scripts/run-rag-eval.ts`). The report includes, per question: the verdict, the judge's one-line
reason, the gold answer, the full model answer, and — for answerable questions — whether the gold
document ever made it into the exact 8 chunks the model was shown (`rankInContext`), so a wrong
verdict can be traced to "retrieval never found it" vs. "found it and still got it wrong." No-answer
questions are graded via the existing abstention classifier, so all three question types land in one
report with one correct/partial/incorrect vocabulary.

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
| `scripts/grade-answers.ts` | Answer-correctness grading (opt-in, see above) |
| `src/eval/adapters/singletopic.ts` | The `singletopic` dataset adapter |
| `test/eval-harness.test.ts` | No DB, no network, no money |
