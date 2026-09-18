import { createHash } from 'node:crypto';
import { seededRandom } from './core.ts';
import {
  BASELINE_RETRIEVAL_KNOBS,
  GBRAIN_RETRIEVAL_KNOBS,
  resolveRetrievalKnobs,
  retrievalKnobHash,
  type DeepReadonly,
  type RetrievalKnobs,
} from '../search/retrieval-knobs.ts';
import type { QueryIntent } from '../search/query-intent.ts';

export const SWEEP_SEED = 42;
export const SWEEP_KS = [4, 8, 12, 16, 20] as const;
export const BOOTSTRAP_RESAMPLES = 10_000;
export const PLANNED_COMPARISONS = 12;

function intentOverride(options: { fusion: boolean; exact: boolean }) {
  const weights = Object.fromEntries(
    (Object.keys(GBRAIN_RETRIEVAL_KNOBS.intent.weights) as QueryIntent[]).map((intent) => {
      const source = GBRAIN_RETRIEVAL_KNOBS.intent.weights[intent];
      return [intent, {
        keywordWeight: options.fusion ? source.keywordWeight : 1,
        vectorWeight: options.fusion ? source.vectorWeight : 1,
        suggestedRecency: null,
        exactMatchBoost: options.exact ? source.exactMatchBoost : 1,
      }];
    }),
  ) as RetrievalKnobs['intent']['weights'];
  return { enabled: true, weights };
}

/** The eight preregistered configurations. Candidate limits, parsing, page cap, and base blend stay fixed. */
export const RETRIEVAL_SWEEP_CONFIGS: Readonly<Record<string, DeepReadonly<RetrievalKnobs>>> = Object.freeze({
  baseline: BASELINE_RETRIEVAL_KNOBS,
  'gbrain-exact-only': resolveRetrievalKnobs({ caller: { intent: intentOverride({ fusion: false, exact: true }) } }),
  'gbrain-fusion-only': resolveRetrievalKnobs({ caller: { intent: intentOverride({ fusion: true, exact: false }) } }),
  'gbrain-intent': GBRAIN_RETRIEVAL_KNOBS,
  'recency-auto-only': resolveRetrievalKnobs({ caller: { recency: { mode: 'auto' } } }),
  'gbrain-intent-auto-recency': resolveRetrievalKnobs({
    defaults: GBRAIN_RETRIEVAL_KNOBS,
    caller: { recency: { mode: 'auto' } },
  }),
  'gbrain-intent-recency-on': resolveRetrievalKnobs({
    defaults: GBRAIN_RETRIEVAL_KNOBS,
    caller: { recency: { mode: 'on' } },
  }),
  'gbrain-intent-recency-strong': resolveRetrievalKnobs({
    defaults: GBRAIN_RETRIEVAL_KNOBS,
    caller: { recency: { mode: 'strong' } },
  }),
  // M9: one-hop graph expansion over `links`, isolated from every intent/recency variant above so
  // its own effect is measured independently. Requires the eval workspace to have been swept by
  // LinkExtractionPhase first (`bun run cycle --phase link_extraction --workspace <eval-ws>`) —
  // link-aware retrieval is meaningless against an unpopulated links table.
  //
  // PLANNED_COMPARISONS is intentionally NOT bumped here. It's a preregistration commitment (the
  // whole point of Bonferroni-correcting is fixing the comparison count before seeing results,
  // per D110's own discipline) — deciding the right count for a 9th profile is a human call to make
  // before the sweep runs, not something to silently adjust in the same change that adds the
  // profile.
  'graph-expansion-only': resolveRetrievalKnobs({ caller: { graphExpansion: { enabled: true } } }),
});

export interface TuningSummary {
  configName: string;
  allEvidenceRecallAt8: number;
  evidenceRecallAt8: number;
  mrr: number;
  p95LatencyMs: number;
}

/** Descending quality, ascending latency, then ascending name for deterministic final ties. */
export function chooseTuningWinner(rows: readonly TuningSummary[]): TuningSummary {
  if (rows.length === 0) throw new Error('cannot choose a tuning winner from zero configurations');
  return [...rows].sort((a, b) =>
    b.allEvidenceRecallAt8 - a.allEvidenceRecallAt8 ||
    b.evidenceRecallAt8 - a.evidenceRecallAt8 ||
    b.mrr - a.mrr ||
    a.p95LatencyMs - b.p95LatencyMs ||
    (a.configName < b.configName ? -1 : a.configName > b.configName ? 1 : 0))[0]!;
}

export interface PairedBootstrapResult {
  meanDelta: number;
  confidenceLow: number;
  confidenceHigh: number;
  rawP: number;
  adjustedP: number;
  significantImprovement: boolean;
  significantRegression: boolean;
}

function quantile(sorted: readonly number[], probability: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(probability * sorted.length)));
  return sorted[index]!;
}

/** Paired bootstrap over question-level candidate-minus-baseline deltas with Bonferroni correction. */
export function pairedBootstrap(
  deltas: readonly number[],
  options: { resamples?: number; seed?: number; comparisons?: number } = {},
): PairedBootstrapResult {
  if (deltas.length === 0) throw new Error('pairedBootstrap requires at least one paired delta');
  const resamples = options.resamples ?? BOOTSTRAP_RESAMPLES;
  const comparisons = options.comparisons ?? PLANNED_COMPARISONS;
  if (!Number.isInteger(resamples) || resamples <= 0) throw new Error('resamples must be a positive integer');
  if (!Number.isInteger(comparisons) || comparisons <= 0) throw new Error('comparisons must be a positive integer');
  const rand = seededRandom(options.seed ?? SWEEP_SEED);
  const means = new Array<number>(resamples);
  for (let sample = 0; sample < resamples; sample++) {
    let sum = 0;
    for (let i = 0; i < deltas.length; i++) sum += deltas[Math.floor(rand() * deltas.length)]!;
    means[sample] = sum / deltas.length;
  }
  means.sort((a, b) => a - b);
  const alpha = 0.05 / comparisons;
  const nonPositive = means.filter((value) => value <= 0).length / resamples;
  const nonNegative = means.filter((value) => value >= 0).length / resamples;
  const rawP = Math.min(1, 2 * Math.min(nonPositive, nonNegative));
  const adjustedP = Math.min(1, rawP * comparisons);
  const confidenceLow = quantile(means, alpha / 2);
  const confidenceHigh = quantile(means, 1 - alpha / 2);
  const meanDelta = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
  return {
    meanDelta,
    confidenceLow,
    confidenceHigh,
    rawP,
    adjustedP,
    significantImprovement: confidenceLow > 0 && adjustedP < 0.05,
    significantRegression: confidenceHigh < 0 && adjustedP < 0.05,
  };
}

export function stableIdHash(ids: readonly string[]): string {
  return createHash('sha256').update([...ids].sort().join('\n')).digest('hex');
}

export function sweepConfigManifest(): Record<string, string> {
  return Object.fromEntries(Object.entries(RETRIEVAL_SWEEP_CONFIGS)
    .map(([name, knobs]) => [name, retrievalKnobHash(knobs)]));
}
