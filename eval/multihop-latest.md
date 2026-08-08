# multihop eval — 2026-08-08T14:09:12.389Z

## Run manifest

```json
{
  "dataset": "multihop",
  "datasetDir": "/Users/taherpanbiharwala/Desktop/Datasets/MultiHopRAG",
  "datasetHash": "956325ee48888cef",
  "gitSha": "a6ca2e2",
  "gitDirty": false,
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
    }
  },
  "degradedCount": 0,
  "erroredCount": 0,
  "startedAt": "2026-08-08T14:09:12.389Z"
}
```

## plain — retrieval (2255 questions scored)

| k | all-evidence-recall | evidence-recall | hit@1 | MRR | distinct docs |
| --- | --- | --- | --- | --- | --- |
| 4 | 22.8% | 53.6% | 60.7% | 0.728 | 3.0 |
| 8 | 36.9% | 66.5% | 60.7% | 0.741 | 5.0 |
| 12 | 46.4% | 73.9% | 60.7% | 0.745 | 6.8 |
| 16 | 51.6% | 78.0% | 60.7% | 0.746 | 8.8 |
| 20 | 57.0% | 81.7% | 60.7% | 0.747 | 11.2 |

**candidate-recall: 85.1%** — share of gold documents present
anywhere in the ~60-chunk pre-fusion pool. A flat k-curve with HIGH candidate-recall is a
ranking problem; with LOW candidate-recall it is arm-limit starvation, which is a free
DB-side fix and no amount of reranking would help.

### plain by hop count — all-evidence-recall, and distinct docs available

| needs | n | @4 | @8 | @12 | @16 | @20 | distinct docs @20 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2 docs | 1169 | 40.3% | 58.7% | 67.5% | 71.9% | 75.6% | 11.5 |
| 3 docs | 774 | 5.4% | 17.6% | 29.7% | 36.3% | 44.2% | 10.7 |
| 4 docs | 312 | 0.6% | 3.5% | 8.7% | 13.5% | 19.2% | 11.3 |

A bucket still climbing at k=20 is budget-limited. A bucket
flat across every k **while distinct docs exceeds what it needs** is a coverage failure —
the document is never retrieved, and slot management cannot reach it.

### plain by question type (all-evidence-recall)

| type | @4 | @8 | @12 | @16 | @20 | n |
| --- | --- | --- | --- | --- | --- | --- |
| comparison_query | 32.7% | 47.9% | 59.5% | 64.3% | 69.0% | 856 |
| inference_query | 9.2% | 20.0% | 27.6% | 33.9% | 39.3% | 816 |
| temporal_query | 27.4% | 44.6% | 53.5% | 57.8% | 64.2% | 583 |

## Retrieval latency

| p50 | p95 | p99 | max | n |
| --- | --- | --- | --- | --- |
| 1946ms | 2333ms | 3919ms | 8608ms | 2255 |

_Measured, not replayed. Any config that buys recall with wall clock shows the price here._

---

_This corpus is public news, and the model may already know its answers — so retrieval numbers
here are trustworthy and answer-correctness is not measured. A config may not be promoted into
production defaults on this dataset alone: it must also hold on a corpus the model has not seen._

