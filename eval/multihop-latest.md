# multihop eval — 2026-08-24T18:31:34.827Z

> **WARNING: 4 of 4510 questions ran keyword-only after an
> embedding failure. Those rows are EXCLUDED below, and the remaining numbers are not
> comparable with a clean run.**

## Run manifest

```json
{
  "dataset": "multihop",
  "datasetDir": "/Users/taherpanbiharwala/Desktop/Datasets/MultiHopRAG",
  "datasetHash": "956325ee48888cef",
  "gitSha": "744ae60",
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
  "maxPerPage": 2,
  "armCaps": {
    "armLimit": 20,
    "kwAndSlots": 20,
    "kwOrSlots": 10,
    "titleLimit": 10,
    "sum": 60
  },
  "autocutRatio": 0,
  "rerankModel": "(off)",
  "queryExpansion": 0,
  "chunkSize": "chunkText: 300 words, overlap 50, maxChars 6000",
  "sampleSeed": 42,
  "questionCount": 2255,
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
  "degradedCount": 4,
  "erroredCount": 0,
  "startedAt": "2026-08-24T18:31:34.827Z"
}
```

## plain — retrieval (2255 questions scored)

| k | all-evidence-recall | evidence-recall | hit@1 | MRR | distinct docs |
| --- | --- | --- | --- | --- | --- |
| 4 | 24.7% | 55.0% | 61.6% | 0.733 | 3.1 |
| 8 | 40.6% | 68.8% | 61.6% | 0.746 | 5.6 |
| 12 | 50.1% | 76.5% | 61.6% | 0.749 | 8.0 |
| 16 | 56.5% | 81.2% | 61.6% | 0.750 | 10.6 |
| 20 | 60.0% | 83.3% | 61.6% | 0.751 | 13.8 |

**candidate-recall: 84.7%** — share of gold documents present
anywhere in the ~60-chunk pre-fusion pool. A flat k-curve with HIGH candidate-recall is a
ranking problem; with LOW candidate-recall it is arm-limit starvation, which is a free
DB-side fix and no amount of reranking would help.

### plain by hop count — all-evidence-recall, and distinct docs available

| needs | n | @4 | @8 | @12 | @16 | @20 | distinct docs @20 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2 docs | 1169 | 42.9% | 61.2% | 70.5% | 75.2% | 78.2% | 14.0 |
| 3 docs | 774 | 7.0% | 23.6% | 35.0% | 43.4% | 47.2% | 13.5 |
| 4 docs | 312 | 0.3% | 5.4% | 10.9% | 18.9% | 23.7% | 13.7 |

A bucket still climbing at k=20 is budget-limited. A bucket
flat across every k **while distinct docs exceeds what it needs** is a coverage failure —
the document is never retrieved, and slot management cannot reach it.

### plain by question type (all-evidence-recall)

| type | @4 | @8 | @12 | @16 | @20 | n |
| --- | --- | --- | --- | --- | --- | --- |
| inference_query | 9.9% | 23.3% | 32.6% | 39.3% | 43.1% | 816 |
| comparison_query | 34.8% | 51.9% | 62.1% | 67.8% | 71.6% | 856 |
| temporal_query | 30.4% | 48.2% | 56.8% | 64.0% | 66.6% | 583 |

## meta — retrieval (2251 questions scored)

| k | all-evidence-recall | evidence-recall | hit@1 | MRR | distinct docs |
| --- | --- | --- | --- | --- | --- |
| 4 | 26.2% | 56.2% | 64.8% | 0.755 | 3.2 |
| 8 | 40.6% | 69.2% | 64.8% | 0.767 | 5.6 |
| 12 | 49.8% | 76.7% | 64.8% | 0.771 | 8.0 |
| 16 | 56.4% | 81.3% | 64.8% | 0.772 | 10.7 |
| 20 | 59.7% | 83.3% | 64.8% | 0.772 | 13.9 |

**candidate-recall: 84.6%** — share of gold documents present
anywhere in the ~60-chunk pre-fusion pool. A flat k-curve with HIGH candidate-recall is a
ranking problem; with LOW candidate-recall it is arm-limit starvation, which is a free
DB-side fix and no amount of reranking would help.

### meta by hop count — all-evidence-recall, and distinct docs available

| needs | n | @4 | @8 | @12 | @16 | @20 | distinct docs @20 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2 docs | 1167 | 44.6% | 62.4% | 70.8% | 75.9% | 79.2% | 14.0 |
| 3 docs | 773 | 8.5% | 22.3% | 34.3% | 42.4% | 45.7% | 13.6 |
| 4 docs | 311 | 0.6% | 4.8% | 10.0% | 18.0% | 21.5% | 13.9 |

A bucket still climbing at k=20 is budget-limited. A bucket
flat across every k **while distinct docs exceeds what it needs** is a coverage failure —
the document is never retrieved, and slot management cannot reach it.

### meta by question type (all-evidence-recall)

| type | @4 | @8 | @12 | @16 | @20 | n |
| --- | --- | --- | --- | --- | --- | --- |
| inference_query | 11.2% | 22.8% | 31.9% | 38.7% | 41.6% | 815 |
| comparison_query | 36.1% | 52.4% | 62.1% | 68.9% | 72.5% | 855 |
| temporal_query | 32.5% | 48.4% | 57.0% | 63.0% | 66.3% | 581 |

## plain vs meta — what the discarded metadata is worth

| k | plain | meta | delta |
| --- | --- | --- | --- |
| 4 | 24.7% | 26.2% | +1.5pp |
| 8 | 40.6% | 40.6% | +0.1pp |
| 12 | 50.1% | 49.8% | -0.2pp |
| 16 | 56.5% | 56.4% | -0.1pp |
| 20 | 60.0% | 59.7% | -0.3pp |

The meta workspace prepends `source | author | published_at` to each document body.
92% of questions name an outlet and only 35% of documents contain their own outlet name;
583 reference dates and `ImportPageInput` has no date field. Retrieval never reads `tags`.
A large delta means retrieval depends on metadata the engine currently cannot index.

## Retrieval latency

| p50 | p95 | p99 | max | n |
| --- | --- | --- | --- | --- |
| 1555ms | 1913ms | 7030ms | 42350ms | 4510 |

_Measured, not replayed. Any config that buys recall with wall clock shows the price here._

---

_This corpus is public news, and the model may already know its answers — so retrieval numbers
here are trustworthy and answer-correctness is not measured. A config may not be promoted into
production defaults on this dataset alone: it must also hold on a corpus the model has not seen._

