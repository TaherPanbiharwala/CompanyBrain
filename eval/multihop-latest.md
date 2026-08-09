# multihop eval — 2026-08-09T15:28:09.271Z

## Run manifest

```json
{
  "dataset": "multihop",
  "datasetDir": "/Users/taherpanbiharwala/Desktop/Datasets/MultiHopRAG",
  "datasetHash": "956325ee48888cef",
  "gitSha": "7c7e707",
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
    }
  },
  "degradedCount": 0,
  "erroredCount": 0,
  "startedAt": "2026-08-09T15:28:09.271Z"
}
```

## plain — retrieval (2255 questions scored)

| k | all-evidence-recall | evidence-recall | hit@1 | MRR | distinct docs |
| --- | --- | --- | --- | --- | --- |
| 4 | 24.7% | 54.8% | 60.7% | 0.729 | 3.1 |
| 8 | 40.3% | 68.8% | 60.7% | 0.743 | 5.6 |
| 12 | 49.9% | 76.4% | 60.7% | 0.745 | 8.0 |
| 16 | 56.3% | 80.9% | 60.7% | 0.746 | 10.7 |
| 20 | 60.1% | 83.6% | 60.7% | 0.747 | 13.8 |

**candidate-recall: 85.1%** — share of gold documents present
anywhere in the ~60-chunk pre-fusion pool. A flat k-curve with HIGH candidate-recall is a
ranking problem; with LOW candidate-recall it is arm-limit starvation, which is a free
DB-side fix and no amount of reranking would help.

### plain by hop count — all-evidence-recall, and distinct docs available

| needs | n | @4 | @8 | @12 | @16 | @20 | distinct docs @20 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2 docs | 1169 | 43.1% | 60.9% | 70.1% | 74.5% | 77.6% | 14.0 |
| 3 docs | 774 | 6.5% | 23.3% | 35.0% | 44.1% | 48.8% | 13.6 |
| 4 docs | 312 | 0.6% | 5.1% | 11.2% | 18.6% | 22.8% | 13.9 |

A bucket still climbing at k=20 is budget-limited. A bucket
flat across every k **while distinct docs exceeds what it needs** is a coverage failure —
the document is never retrieved, and slot management cannot reach it.

### plain by question type (all-evidence-recall)

| type | @4 | @8 | @12 | @16 | @20 | n |
| --- | --- | --- | --- | --- | --- | --- |
| inference_query | 10.2% | 22.8% | 32.5% | 39.2% | 42.4% | 816 |
| comparison_query | 35.4% | 51.9% | 61.9% | 67.9% | 72.9% | 856 |
| temporal_query | 29.2% | 47.7% | 56.6% | 63.3% | 66.2% | 583 |

## Retrieval latency

| p50 | p95 | p99 | max | n |
| --- | --- | --- | --- | --- |
| 1817ms | 2606ms | 3503ms | 5559ms | 2255 |

_Measured, not replayed. Any config that buys recall with wall clock shows the price here._

---

_This corpus is public news, and the model may already know its answers — so retrieval numbers
here are trustworthy and answer-correctness is not measured. A config may not be promoted into
production defaults on this dataset alone: it must also hold on a corpus the model has not seen._

