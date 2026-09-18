# M7 retrieval sweep — 2026-09-06T17:08:17.231Z

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
    "baseline": "ad7e6a835e31266b856556f315f07b79c666e6518b914097d01d7864769e980c",
    "gbrain-exact-only": "39079f2897d654a7eed3cfda25af04c878e0b448279fbc9b4c1bae4f38de9192",
    "gbrain-fusion-only": "2dbde17c74803bd2a01cc3ceba1c95597be7c92f4bae46c89bf3f2f7cfcfd6a9",
    "gbrain-intent": "bfcbaa2d16769310a56dc7c40e3f4024d54314b1822fdb8b0b6c0be850cb9a86",
    "recency-auto-only": "b9919135f95e521bc544398b9f086c14205a5d529baa95a3b6778228bad8c720",
    "gbrain-intent-auto-recency": "40814af93bd25d0bb489efdef5887ba41a0ea75576c875dc8f7d776e76a766a2",
    "gbrain-intent-recency-on": "f9f5d3b24d774534c2ba8a7651958296b4b135f6b2f4cd437fcb7fbbb9794dac",
    "gbrain-intent-recency-strong": "e20b6d0957cdf9e2142d748e4ab8fa1d94b52f7b34b81276575ef69291df5cfb"
  },
  "configDefinitionHash": "3ad5b8f2b0cac531c77bf9c21e96cb6b644e42630f9806bcb259f00871b9a085",
  "embeddingModel": "openai:text-embedding-3-small",
  "bootstrapResamples": 10000,
  "plannedComparisons": 12
}
```

## Tuning results

| config | all@8 | evidence@8 | MRR | candidate | p50 ms | Δp50 ms | p95 ms | Δp95 ms | fixed | broken | degraded | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 38.76% | 68.07% | 0.7455 | 84.29% | 1899 | +0 | 2680 | +0 | 0 | 0 | 0 | 0 |
| gbrain-exact-only | 38.76% | 68.07% | 0.7455 | 84.29% | 1907 | +8 | 3709 | +1029 | 0 | 0 | 0 | 0 |
| gbrain-fusion-only | 39.01% | 68.29% | 0.7469 | 84.29% | 1585 | -314 | 2499 | -180 | 7 | 3 | 0 | 0 |
| gbrain-intent | 39.01% | 68.29% | 0.7469 | 84.29% | 1666 | -233 | 2936 | +256 | 7 | 3 | 0 | 0 |
| recency-auto-only | 38.32% | 67.95% | 0.7450 | 84.29% | 1616 | -283 | 2643 | -37 | 6 | 13 | 0 | 0 |
| gbrain-intent-auto-recency | 38.57% | 68.09% | 0.7456 | 84.29% | 1562 | -337 | 1992 | -688 | 12 | 15 | 0 | 0 |
| gbrain-intent-recency-on | 38.63% | 68.03% | 0.7477 | 84.29% | 1540 | -359 | 1934 | -746 | 24 | 26 | 0 | 0 |
| gbrain-intent-recency-strong | 38.44% | 68.05% | 0.7432 | 84.29% | 1552 | -347 | 1963 | -716 | 27 | 32 | 0 | 0 |

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
| 4 | 23.12% | 53.69% | 0.7310 |
| 8 | 38.57% | 68.09% | 0.7456 |
| 12 | 48.96% | 76.13% | 0.7487 |
| 16 | 54.53% | 80.34% | 0.7498 |
| 20 | 58.90% | 83.05% | 0.7502 |

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

## Holdout gate — FAIL

Winner: **gbrain-fusion-only**

```json
{
  "passed": false,
  "winner": "gbrain-fusion-only",
  "overall": {
    "meanDelta": 0.004437869822485207,
    "confidenceLow": 0,
    "confidenceHigh": 0.013313609467455622,
    "rawP": 0.0996,
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
      "rawP": 0.1022,
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
  "baselineP95LatencyMs": 2107.5066669993103,
  "candidateP95LatencyMs": 1816.4674579994753,
  "latencyRatio": 0.8619035405405291,
  "zeroDegradedAndErrored": true,
  "fixed": 3,
  "broken": 0,
  "reasons": [
    "overall adjusted confidence interval/p-value gate did not pass"
  ]
}
```

