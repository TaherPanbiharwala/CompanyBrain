import { describe, expect, it } from 'bun:test';
import {
  BASELINE_RETRIEVAL_KNOBS,
  DEFAULT_RETRIEVAL_KNOBS,
  GBRAIN_RETRIEVAL_KNOBS,
  effectiveRecencyMode,
  isExactMatch,
  parseRetrievalKnobOverrides,
  resolveRetrievalKnobs,
  retrievalKnobHash,
} from '../src/search/retrieval-knobs.ts';
import { parseConfig } from '../src/config.ts';
import { classifyQuery } from '../src/search/query-intent.ts';

describe('retrieval policy', () => {
  it('pins baseline and gbrain profiles without pre-promoting the default', () => {
    expect(DEFAULT_RETRIEVAL_KNOBS).toBe(BASELINE_RETRIEVAL_KNOBS);
    expect(BASELINE_RETRIEVAL_KNOBS.intent.enabled).toBe(false);
    expect(GBRAIN_RETRIEVAL_KNOBS.intent.enabled).toBe(true);
    expect(GBRAIN_RETRIEVAL_KNOBS.intent.weights.event).toEqual({
      keywordWeight: 1.2,
      vectorWeight: 0.95,
      suggestedRecency: 'on',
      exactMatchBoost: 1.1,
    });
    expect(GBRAIN_RETRIEVAL_KNOBS.intent.weights.concept.vectorWeight).toBe(1.2);
  });

  it('deep-merges reserved, environment, and caller layers in that order', () => {
    const resolved = resolveRetrievalKnobs({
      reserved: { candidatePool: { vectorLimit: 12 }, recency: { coefficient: 0.1 } },
      environment: { candidatePool: { vectorLimit: 15 }, recency: { mode: 'auto' } },
      caller: { candidatePool: { vectorLimit: 18 }, recency: { coefficient: 0.5 } },
    });
    expect(resolved.candidatePool.vectorLimit).toBe(18);
    expect(resolved.candidatePool.keywordAndLimit).toBe(20);
    expect(resolved.recency).toEqual({ mode: 'auto', halflifeDays: 90, coefficient: 0.5 });
  });

  it('does not mutate or expose mutable shared profiles', () => {
    const resolved = resolveRetrievalKnobs({ caller: { candidatePool: { vectorLimit: 99 } } });
    expect(resolved.candidatePool.vectorLimit).toBe(99);
    expect(BASELINE_RETRIEVAL_KNOBS.candidatePool.vectorLimit).toBe(20);
    expect(Object.isFrozen(resolved.candidatePool)).toBe(true);
    expect(Object.isFrozen(resolved.intent.weights.entity)).toBe(true);
  });

  it('rejects malformed JSON and unknown fields', () => {
    expect(() => parseRetrievalKnobOverrides('{nope')).toThrow('malformed JSON');
    expect(() => parseRetrievalKnobOverrides('{"fusion":{"mystery":1}}')).toThrow('fusion.mystery');
  });

  it('fails startup parsing on an unsafe server-wide override', () => {
    expect(() => parseConfig({ CB_RETRIEVAL_KNOBS_JSON: '{"fusion":{"autocutRatio":1}}' }))
      .toThrow('fusion.autocutRatio');
    expect(parseConfig({ CB_RETRIEVAL_KNOBS_JSON: '{"candidatePool":{"vectorLimit":7}}' })
      .retrievalKnobs.candidatePool.vectorLimit).toBe(7);
  });

  it.each([
    [{ candidatePool: { vectorLimit: 0, keywordAndLimit: 0, keywordOrLimit: 0, titleLimit: 0 } }, 'at least one'],
    [{ candidatePool: { vectorLimit: 101 } }, 'less than or equal to 100'],
    [{ candidatePool: { maxPerPage: 0 } }, 'greater than or equal to 1'],
    [{ candidatePool: { rerankOverfetch: 11 } }, 'less than or equal to 10'],
    [{ keyword: { minTermChars: 11 } }, 'less than or equal to 10'],
    [{ keyword: { maxTerms: 0 } }, 'greater than or equal to 1'],
    [{ fusion: { rrfK: 0 } }, 'greater than or equal to 1'],
    [{ fusion: { keywordAndWeight: 0 } }, 'greater than 0'],
    [{ fusion: { rrfBlend: 0.6 } }, 'sum exactly to 1'],
    [{ fusion: { autocutRatio: 1 } }, 'less than 1'],
    [{ recency: { halflifeDays: 3651 } }, 'less than or equal to 3650'],
    [{ recency: { coefficient: 2.1 } }, 'less than or equal to 2'],
  ] as const)('rejects unsafe override %#', (caller, message) => {
    expect(() => resolveRetrievalKnobs({ caller })).toThrow(message);
  });

  it('hashes canonical content rather than object identity', () => {
    const a = resolveRetrievalKnobs({ caller: { recency: { mode: 'auto' }, candidatePool: { vectorLimit: 33 } } });
    const b = resolveRetrievalKnobs({ caller: { candidatePool: { vectorLimit: 33 }, recency: { mode: 'auto' } } });
    expect(retrievalKnobHash(a)).toBe(retrievalKnobHash(b));
    expect(retrievalKnobHash(a)).not.toBe(retrievalKnobHash(BASELINE_RETRIEVAL_KNOBS));
    expect(retrievalKnobHash(a)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('resolves off/auto/on/strong without silently enabling default recency', () => {
    const temporal = { intent: 'temporal', suggestedRecency: 'off' } as const;
    expect(effectiveRecencyMode(BASELINE_RETRIEVAL_KNOBS, temporal)).toBe('off');
    const auto = resolveRetrievalKnobs({
      caller: { recency: { mode: 'auto' } },
    });
    expect(effectiveRecencyMode(auto, temporal)).toBe('on');
    expect(effectiveRecencyMode(auto, classifyQuery('what is the history of Acme'))).toBe('off');
    expect(effectiveRecencyMode(auto, { intent: 'general', suggestedRecency: 'strong' })).toBe('strong');
    expect(effectiveRecencyMode(resolveRetrievalKnobs({ caller: { recency: { mode: 'on' } } }), temporal)).toBe('on');
  });

  it('copies gbrain exact-match normalization', () => {
    expect(isExactMatch('Garry Tan', 'garry-tan', null)).toBe(true);
    expect(isExactMatch('Garry Tan', 'people/garry-tan', null)).toBe(true);
    expect(isExactMatch(' garry tan ', 'ignored', '  Garry Tan ')).toBe(true);
    expect(isExactMatch('Garry Tan', 'people/not-garry', 'Garry Tann')).toBe(false);
  });

  describe('graphExpansion (M9)', () => {
    it('ships off by default, matching the D110/D111 evidence-gated precedent', () => {
      expect(BASELINE_RETRIEVAL_KNOBS.graphExpansion.enabled).toBe(false);
      expect(DEFAULT_RETRIEVAL_KNOBS.graphExpansion.enabled).toBe(false);
    });

    it('merges through the same reserved/environment/caller layering as every other knob', () => {
      const resolved = resolveRetrievalKnobs({
        reserved: { graphExpansion: { enabled: true } },
        caller: { graphExpansion: { maxNeighborsPerSeed: 5 } },
      });
      expect(resolved.graphExpansion).toEqual({ enabled: true, maxNeighborsPerSeed: 5, weight: 0.3 });
    });

    it('rejects an unknown field and an out-of-range value', () => {
      expect(() => resolveRetrievalKnobs({ caller: { graphExpansion: { mystery: 1 } } as never })).toThrow('graphExpansion.mystery');
      expect(() => resolveRetrievalKnobs({ caller: { graphExpansion: { maxNeighborsPerSeed: 0 } } })).toThrow();
      expect(() => resolveRetrievalKnobs({ caller: { graphExpansion: { maxNeighborsPerSeed: 11 } } })).toThrow();
    });

    it('changes the knob hash when toggled, and not when left at its default', () => {
      const on = resolveRetrievalKnobs({ caller: { graphExpansion: { enabled: true } } });
      expect(retrievalKnobHash(on)).not.toBe(retrievalKnobHash(BASELINE_RETRIEVAL_KNOBS));
      const unchanged = resolveRetrievalKnobs({ caller: { candidatePool: { vectorLimit: 20 } } });
      expect(retrievalKnobHash(unchanged)).toBe(retrievalKnobHash(BASELINE_RETRIEVAL_KNOBS));
    });
  });
});
