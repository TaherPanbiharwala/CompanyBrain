# M7 retrieval sweep — 2026-09-19T19:11:33.830Z

## Immutable run contract

```json
{
  "rowSchemaVersion": 1,
  "dataset": "multihop",
  "datasetHash": "89eca3ff19c65d1ca1eb70e9004ea195bb9aabf752fe1da5fd1c637ccfad718a",
  "splitSeed": 42,
  "tuningFraction": 0.7,
  "tuningCount": 1579,
  "holdoutCount": 676,
  "tuningIdHash": "fd613a8b81efea8fd08c4c23a97bf0d82426a4c5d8da0536f6d1b847e299cda4",
  "holdoutIdHash": "dd765051a8fc3177da7a73d86a419e7315b8654cd3e7ea42865ff22aeb36c2ad",
  "recencyAsOf": "2023-12-26",
  "variant": "plain",
  "reportKs": [
    4,
    8,
    12,
    16,
    20
  ],
  "poolK": 60,
  "configHashes": {
    "baseline": "db5f6bfa4a4a0eb1cf6285d35921e2864eeb0cd0f9dcdfb2553d85b39e4dc162",
    "gbrain-exact-only": "fa947dd098897fb703a20fb233f5eb5dd5b30c4452c0aad25e562c4aaca79393",
    "gbrain-fusion-only": "bc55ef47900bbc8c6a56c9bb3ff7ca7f6e9ea365331581c8f07ff4eab1b46725",
    "gbrain-intent": "b18756ecfa606396b7997df3f3f89338a4f9a47e1dd8308479917fa0799e53b8",
    "recency-auto-only": "38480c7d6871914cb0deebd300f58691ceec3f8d43f5e1a8b61e5b354899500d",
    "gbrain-intent-auto-recency": "afe62d2268143f915aa2b18a7e0dc235e8a8a2e76adce35c45cc4b8b4da3b795",
    "gbrain-intent-recency-on": "000833ae6def2f384f18ee2700f15810db34f783d96e5ec6c3a08422f1c77d7b",
    "gbrain-intent-recency-strong": "3c6bd3d6c746394961702ca1160b4084e71fc46e17d5b4fd7eb2a41c6bb193d4",
    "graph-expansion-only": "b83ddfa3f041ea0575969616855ba2aa0d69ed161912804143d1e293e9d407b5"
  },
  "configDefinitionHash": "18bdb9d56b0b5db30d870aa0d6ac88122b5103c63b3bbf95edf2a6a90b1a6c62",
  "embeddingModel": "openai:text-embedding-3-small",
  "bootstrapResamples": 10000,
  "plannedComparisons": 12
}
```

## Tuning results

| config | all@8 | evidence@8 | MRR | candidate | p50 ms | Δp50 ms | p95 ms | Δp95 ms | fixed | broken | degraded | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 38.76% | 68.07% | 0.7455 | 84.29% | 1946 | +0 | 2277 | +0 | 0 | 0 | 0 | 0 |
| gbrain-exact-only | 38.76% | 68.07% | 0.7455 | 84.29% | 1563 | -382 | 1918 | -359 | 0 | 0 | 0 | 0 |
| gbrain-fusion-only | 39.01% | 68.29% | 0.7469 | 84.29% | 1546 | -400 | 1867 | -410 | 7 | 3 | 0 | 0 |
| gbrain-intent | 39.01% | 68.29% | 0.7469 | 84.29% | 1556 | -390 | 1935 | -342 | 7 | 3 | 0 | 0 |
| recency-auto-only | 38.32% | 67.95% | 0.7450 | 84.29% | 1571 | -375 | 1952 | -325 | 6 | 13 | 0 | 0 |
| gbrain-intent-auto-recency | 38.59% | 68.09% | 0.7454 | 84.30% | 1782 | -163 | 2257 | -20 | 12 | 15 | 0 | 1 |
| gbrain-intent-recency-on | 38.63% | 68.03% | 0.7477 | 84.29% | 1794 | -151 | 2314 | +37 | 24 | 26 | 0 | 0 |
| gbrain-intent-recency-strong | 38.44% | 68.05% | 0.7432 | 84.29% | 1571 | -375 | 1943 | -335 | 27 | 32 | 0 | 0 |
| graph-expansion-only | 38.68% | 68.03% | 0.7455 | 84.27% | 1570 | -376 | 2093 | -185 | 0 | 2 | 0 | 2 |

### baseline

| k | all evidence | evidence | MRR |
| --- | --- | --- | --- |
| 4 | 23.24% | 54.05% | 0.7323 |
| 8 | 38.76% | 68.07% | 0.7455 |
| 12 | 48.51% | 76.06% | 0.7490 |
| 16 | 54.97% | 80.54% | 0.7499 |
| 20 | 58.83% | 83.09% | 0.7503 |

hop recall@8: 2=59.10%, 3=21.40%, 4=5.50%

dataset type recall@8: comparison_query=51.17%, inference_query=21.89%, temporal_query=44.12%

classifier intent recall@8: concept=0.00%, entity=15.28%, event=43.20%, general=42.79%, temporal=38.85%

### gbrain-exact-only

| k | all evidence | evidence | MRR |
| --- | --- | --- | --- |
| 4 | 23.24% | 54.05% | 0.7323 |
| 8 | 38.76% | 68.07% | 0.7455 |
| 12 | 48.51% | 76.06% | 0.7490 |
| 16 | 54.97% | 80.54% | 0.7499 |
| 20 | 58.83% | 83.09% | 0.7503 |

hop recall@8: 2=59.10%, 3=21.40%, 4=5.50%

dataset type recall@8: comparison_query=51.17%, inference_query=21.89%, temporal_query=44.12%

classifier intent recall@8: concept=0.00%, entity=15.28%, event=43.20%, general=42.79%, temporal=38.85%

### gbrain-fusion-only

| k | all evidence | evidence | MRR |
| --- | --- | --- | --- |
| 4 | 23.50% | 54.25% | 0.7339 |
| 8 | 39.01% | 68.29% | 0.7469 |
| 12 | 48.89% | 76.15% | 0.7501 |
| 16 | 54.72% | 80.48% | 0.7512 |
| 20 | 58.83% | 83.07% | 0.7516 |

hop recall@8: 2=59.83%, 3=21.03%, 4=5.50%

dataset type recall@8: comparison_query=52.17%, inference_query=21.54%, temporal_query=44.12%

classifier intent recall@8: concept=0.00%, entity=15.28%, event=43.88%, general=42.79%, temporal=38.85%

### gbrain-intent

| k | all evidence | evidence | MRR |
| --- | --- | --- | --- |
| 4 | 23.50% | 54.25% | 0.7339 |
| 8 | 39.01% | 68.29% | 0.7469 |
| 12 | 48.89% | 76.15% | 0.7501 |
| 16 | 54.72% | 80.48% | 0.7512 |
| 20 | 58.83% | 83.07% | 0.7516 |

hop recall@8: 2=59.83%, 3=21.03%, 4=5.50%

dataset type recall@8: comparison_query=52.17%, inference_query=21.54%, temporal_query=44.12%

classifier intent recall@8: concept=0.00%, entity=15.28%, event=43.88%, general=42.79%, temporal=38.85%

### recency-auto-only

| k | all evidence | evidence | MRR |
| --- | --- | --- | --- |
| 4 | 23.12% | 53.76% | 0.7308 |
| 8 | 38.32% | 67.95% | 0.7450 |
| 12 | 48.26% | 75.85% | 0.7483 |
| 16 | 54.59% | 80.35% | 0.7493 |
| 20 | 58.77% | 83.02% | 0.7497 |

hop recall@8: 2=58.49%, 3=21.03%, 4=5.50%

dataset type recall@8: comparison_query=50.50%, inference_query=21.37%, temporal_query=44.12%

classifier intent recall@8: concept=0.00%, entity=15.28%, event=42.69%, general=42.63%, temporal=36.94%

### gbrain-intent-auto-recency

| k | all evidence | evidence | MRR |
| --- | --- | --- | --- |
| 4 | 23.13% | 53.68% | 0.7308 |
| 8 | 38.59% | 68.09% | 0.7454 |
| 12 | 48.99% | 76.14% | 0.7485 |
| 16 | 54.56% | 80.35% | 0.7496 |
| 20 | 58.94% | 83.06% | 0.7500 |

hop recall@8: 2=59.22%, 3=20.66%, 4=5.50%

dataset type recall@8: comparison_query=51.50%, inference_query=21.02%, temporal_query=44.12%

classifier intent recall@8: concept=0.00%, entity=15.28%, event=43.37%, general=42.63%, temporal=36.94%

### gbrain-intent-recency-on

| k | all evidence | evidence | MRR |
| --- | --- | --- | --- |
| 4 | 23.62% | 54.07% | 0.7335 |
| 8 | 38.63% | 68.03% | 0.7477 |
| 12 | 48.64% | 75.94% | 0.7511 |
| 16 | 54.65% | 80.33% | 0.7523 |
| 20 | 58.96% | 83.06% | 0.7527 |

hop recall@8: 2=59.58%, 3=20.30%, 4=5.50%

dataset type recall@8: comparison_query=51.83%, inference_query=20.14%, temporal_query=45.10%

classifier intent recall@8: concept=0.00%, entity=13.89%, event=43.20%, general=43.60%, temporal=36.31%

### gbrain-intent-recency-strong

| k | all evidence | evidence | MRR |
| --- | --- | --- | --- |
| 4 | 23.50% | 53.82% | 0.7278 |
| 8 | 38.44% | 68.05% | 0.7432 |
| 12 | 48.64% | 75.99% | 0.7467 |
| 16 | 54.27% | 80.07% | 0.7478 |
| 20 | 58.64% | 82.97% | 0.7483 |

hop recall@8: 2=59.34%, 3=20.11%, 4=5.50%

dataset type recall@8: comparison_query=51.67%, inference_query=20.14%, temporal_query=44.61%

classifier intent recall@8: concept=0.00%, entity=13.89%, event=42.86%, general=43.76%, temporal=35.03%

### graph-expansion-only

| k | all evidence | evidence | MRR |
| --- | --- | --- | --- |
| 4 | 23.15% | 53.99% | 0.7323 |
| 8 | 38.68% | 68.03% | 0.7455 |
| 12 | 48.45% | 76.03% | 0.7490 |
| 16 | 54.91% | 80.51% | 0.7499 |
| 20 | 58.78% | 83.07% | 0.7503 |

hop recall@8: 2=58.85%, 3=21.40%, 4=5.50%

dataset type recall@8: comparison_query=51.00%, inference_query=21.89%, temporal_query=43.87%

classifier intent recall@8: concept=0.00%, entity=15.28%, event=43.20%, general=42.46%, temporal=38.85%

## Holdout gate — FAIL

Winner: **gbrain-intent**

```json
{
  "passed": false,
  "winner": "gbrain-intent",
  "overall": {
    "meanDelta": 0.004437869822485207,
    "confidenceLow": 0,
    "confidenceHigh": 0.013313609467455622,
    "rawP": 0.102,
    "adjustedP": 1,
    "significantImprovement": false,
    "significantRegression": false
  },
  "subgroups": {
    "type:comparison_query": {
      "meanDelta": 0.00390625,
      "confidenceLow": 0,
      "confidenceHigh": 0.01953125,
      "rawP": 0.7258,
      "adjustedP": 1,
      "significantImprovement": false,
      "significantRegression": false
    },
    "type:inference_query": {
      "meanDelta": 0.004081632653061225,
      "confidenceLow": 0,
      "confidenceHigh": 0.02040816326530612,
      "rawP": 0.722,
      "adjustedP": 1,
      "significantImprovement": false,
      "significantRegression": false
    },
    "type:temporal_query": {
      "meanDelta": 0.005714285714285714,
      "confidenceLow": 0,
      "confidenceHigh": 0.02857142857142857,
      "rawP": 0.7448,
      "adjustedP": 1,
      "significantImprovement": false,
      "significantRegression": false
    },
    "hop:2": {
      "meanDelta": 0.008571428571428572,
      "confidenceLow": 0,
      "confidenceHigh": 0.025714285714285714,
      "rawP": 0.0982,
      "adjustedP": 1,
      "significantImprovement": false,
      "significantRegression": false
    },
    "hop:3": {
      "meanDelta": 0,
      "confidenceLow": 0,
      "confidenceHigh": 0,
      "rawP": 1,
      "adjustedP": 1,
      "significantImprovement": false,
      "significantRegression": false
    },
    "hop:4": {
      "meanDelta": 0,
      "confidenceLow": 0,
      "confidenceHigh": 0,
      "rawP": 1,
      "adjustedP": 1,
      "significantImprovement": false,
      "significantRegression": false
    },
    "intent:entity": {
      "meanDelta": 0.010101010101010102,
      "confidenceLow": 0,
      "confidenceHigh": 0.050505050505050504,
      "rawP": 0.7056,
      "adjustedP": 1,
      "significantImprovement": false,
      "significantRegression": false
    },
    "intent:event": {
      "meanDelta": 0.008333333333333333,
      "confidenceLow": 0,
      "confidenceHigh": 0.029166666666666667,
      "rawP": 0.2818,
      "adjustedP": 1,
      "significantImprovement": false,
      "significantRegression": false
    },
    "intent:general": {
      "meanDelta": 0,
      "confidenceLow": 0,
      "confidenceHigh": 0,
      "rawP": 1,
      "adjustedP": 1,
      "significantImprovement": false,
      "significantRegression": false
    },
    "intent:temporal": {
      "meanDelta": 0,
      "confidenceLow": 0,
      "confidenceHigh": 0,
      "rawP": 1,
      "adjustedP": 1,
      "significantImprovement": false,
      "significantRegression": false
    }
  },
  "significantRegressions": [],
  "baselineP95LatencyMs": 2361.796541000018,
  "candidateP95LatencyMs": 1968.5783339999616,
  "latencyRatio": 0.8335088564260653,
  "zeroDegradedAndErrored": true,
  "fixed": 3,
  "broken": 0,
  "reasons": [
    "overall adjusted confidence interval/p-value gate did not pass"
  ]
}
```

