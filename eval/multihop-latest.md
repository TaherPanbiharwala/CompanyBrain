# multihop eval — 2026-08-06T21:58:26.774Z

> **WARNING: 1 of 80 questions ran keyword-only after an
> embedding failure. Those rows are EXCLUDED below, and the remaining numbers are not
> comparable with a clean run.**

## Run manifest

```json
{
  "dataset": "multihop",
  "datasetDir": "/Users/taherpanbiharwala/Desktop/Datasets/MultiHopRAG",
  "datasetHash": "956325ee48888cef",
  "gitSha": "800c50d",
  "gitDirty": true,
  "chatModel": "(not used — retrieval tier makes no chat calls)",
  "embeddingModel": "openai:text-embedding-3-small",
  "embeddingDim": 1536,
  "defaultTopK": 8,
  "poolK": 60,
  "reportKs": [
    4,
    8,
    12,
    16,
    20
  ],
  "maxPerPage": 3,
  "autocutRatio": 0,
  "rerankModel": "(off)",
  "queryExpansion": 0,
  "chunkSize": "chunkText: 300 words, overlap 50, maxChars 6000",
  "sampleSeed": 42,
  "questionCount": 40,
  "workspaces": {
    "plain": {
      "id": "843723e5-ded6-4ed4-bc95-523378609330",
      "pages": 609,
      "chunks": 2829
    },
    "meta": {
      "id": "d70e55c8-cf23-4763-b5e1-df27a5b092b4",
      "pages": 609,
      "chunks": 2844
    }
  },
  "degradedCount": 1,
  "erroredCount": 0,
  "startedAt": "2026-08-06T21:58:26.774Z"
}
```

## plain — retrieval (40 questions scored)

| k | all-evidence-recall | evidence-recall | hit@1 | MRR | distinct docs |
| --- | --- | --- | --- | --- | --- |
| 4 | 17.5% | 52.1% | 70.0% | 0.790 | 3.0 |
| 8 | 27.5% | 62.3% | 70.0% | 0.806 | 5.0 |
| 12 | 35.0% | 69.8% | 70.0% | 0.806 | 6.8 |
| 16 | 40.0% | 72.9% | 70.0% | 0.806 | 8.7 |
| 20 | 45.0% | 76.5% | 70.0% | 0.808 | 11.3 |

**candidate-recall: 82.5%** — share of gold documents present
anywhere in the ~60-chunk pre-fusion pool. A flat k-curve with HIGH candidate-recall is a
ranking problem; with LOW candidate-recall it is arm-limit starvation, which is a free
DB-side fix and no amount of reranking would help.

### plain by question type (all-evidence-recall)

| type | @4 | @8 | @12 | @16 | @20 | n |
| --- | --- | --- | --- | --- | --- | --- |
| comparison_query | 26.7% | 40.0% | 53.3% | 53.3% | 53.3% | 15 |
| inference_query | 6.7% | 13.3% | 13.3% | 26.7% | 40.0% | 15 |
| temporal_query | 20.0% | 30.0% | 40.0% | 40.0% | 40.0% | 10 |

## meta — retrieval (39 questions scored)

| k | all-evidence-recall | evidence-recall | hit@1 | MRR | distinct docs |
| --- | --- | --- | --- | --- | --- |
| 4 | 15.4% | 49.8% | 66.7% | 0.765 | 3.1 |
| 8 | 25.6% | 61.3% | 66.7% | 0.784 | 5.0 |
| 12 | 33.3% | 67.3% | 66.7% | 0.784 | 6.9 |
| 16 | 35.9% | 71.4% | 66.7% | 0.784 | 8.8 |
| 20 | 41.0% | 75.0% | 66.7% | 0.786 | 11.2 |

**candidate-recall: 80.3%** — share of gold documents present
anywhere in the ~60-chunk pre-fusion pool. A flat k-curve with HIGH candidate-recall is a
ranking problem; with LOW candidate-recall it is arm-limit starvation, which is a free
DB-side fix and no amount of reranking would help.

### meta by question type (all-evidence-recall)

| type | @4 | @8 | @12 | @16 | @20 | n |
| --- | --- | --- | --- | --- | --- | --- |
| comparison_query | 26.7% | 40.0% | 53.3% | 53.3% | 53.3% | 15 |
| inference_query | 6.7% | 13.3% | 13.3% | 20.0% | 33.3% | 15 |
| temporal_query | 11.1% | 22.2% | 33.3% | 33.3% | 33.3% | 9 |

## plain vs meta — what the discarded metadata is worth

| k | plain | meta | delta |
| --- | --- | --- | --- |
| 4 | 17.5% | 15.4% | -2.1pp |
| 8 | 27.5% | 25.6% | -1.9pp |
| 12 | 35.0% | 33.3% | -1.7pp |
| 16 | 40.0% | 35.9% | -4.1pp |
| 20 | 45.0% | 41.0% | -4.0pp |

The meta workspace prepends `source | author | published_at` to each document body.
92% of questions name an outlet and only 35% of documents contain their own outlet name;
583 reference dates and `ImportPageInput` has no date field. Retrieval never reads `tags`.
A large delta means retrieval depends on metadata the engine currently cannot index.

---

_No number here may justify a change to `src/search/hybrid.ts`, chunking, or
the prompt: every question is multi-hop, real traffic is mostly single-hop._

