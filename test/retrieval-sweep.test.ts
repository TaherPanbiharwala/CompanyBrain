import { describe, expect, it } from 'bun:test';
import { stratifiedSplit } from '../src/eval/core.ts';
import type { EvalQuestion } from '../src/eval/types.ts';
import {
  RETRIEVAL_SWEEP_CONFIGS,
  chooseTuningWinner,
  pairedBootstrap,
  stableIdHash,
  sweepConfigManifest,
} from '../src/eval/retrieval-sweep.ts';

const questions: EvalQuestion[] = Array.from({ length: 40 }, (_, index) => ({
  id: `q-${String(index).padStart(2, '0')}`,
  text: `question ${index}`,
  type: ['temporal', 'entity'][index % 2],
  goldDocIds: Array.from({ length: index % 4 + 1 }, (__, hop) => `d-${index}-${hop}`),
}));

describe('held-out retrieval sweep primitives', () => {
  it('jointly stratifies type + required-document count with deterministic isolation', () => {
    const a = stratifiedSplit(questions, 0.7, 42);
    const b = stratifiedSplit([...questions].reverse(), 0.7, 42);
    expect(a.tuning.map((q) => q.id)).toEqual(b.tuning.map((q) => q.id));
    expect(a.holdout.map((q) => q.id)).toEqual(b.holdout.map((q) => q.id));
    expect(a.tuning).toHaveLength(28);
    expect(a.holdout).toHaveLength(12);
    const tuningIds = new Set(a.tuning.map((q) => q.id));
    expect(a.holdout.some((q) => tuningIds.has(q.id))).toBe(false);
    expect(new Set([...a.tuning, ...a.holdout].map((q) => q.id)).size).toBe(questions.length);
  });

  it('registers exactly the nine preregistered configurations with stable hashes', () => {
    // Eight from M7, plus M9's graph-expansion-only — see retrieval-sweep.ts's own comment on why
    // PLANNED_COMPARISONS is not bumped in the same change that adds this profile.
    expect(Object.keys(RETRIEVAL_SWEEP_CONFIGS)).toEqual([
      'baseline',
      'gbrain-exact-only',
      'gbrain-fusion-only',
      'gbrain-intent',
      'recency-auto-only',
      'gbrain-intent-auto-recency',
      'gbrain-intent-recency-on',
      'gbrain-intent-recency-strong',
      'graph-expansion-only',
    ]);
    const manifest = sweepConfigManifest();
    expect(new Set(Object.values(manifest)).size).toBe(9);
    expect(Object.values(manifest).every((hash) => /^[a-f0-9]{64}$/.test(hash))).toBe(true);
  });

  it('selects lexicographically across the registered winner criteria', () => {
    const base = { allEvidenceRecallAt8: 0.5, evidenceRecallAt8: 0.7, mrr: 0.8, p95LatencyMs: 100 };
    expect(chooseTuningWinner([
      { configName: 'z', ...base },
      { configName: 'a', ...base },
    ]).configName).toBe('a');
    expect(chooseTuningWinner([
      { configName: 'lower-primary', ...base },
      { configName: 'winner', ...base, allEvidenceRecallAt8: 0.51, p95LatencyMs: 999 },
    ]).configName).toBe('winner');
  });

  it('makes bootstrap and Bonferroni correction reproducible', () => {
    const deltas = Array.from({ length: 80 }, (_, index) => index < 60 ? 1 : 0);
    const a = pairedBootstrap(deltas, { resamples: 2_000, seed: 42, comparisons: 12 });
    const b = pairedBootstrap(deltas, { resamples: 2_000, seed: 42, comparisons: 12 });
    expect(a).toEqual(b);
    expect(a.confidenceLow).toBeGreaterThan(0);
    expect(a.adjustedP).toBeLessThan(0.05);
    expect(a.significantImprovement).toBe(true);
    expect(pairedBootstrap(deltas.map((d) => -d), { resamples: 2_000 }).significantRegression).toBe(true);
  });

  it('hashes ID sets independently of order', () => {
    expect(stableIdHash(['b', 'a'])).toBe(stableIdHash(['a', 'b']));
    expect(stableIdHash(['a'])).not.toBe(stableIdHash(['a', 'b']));
  });
});
