import { describe, expect, it } from 'bun:test';
import { pickDuplicate, DEDUP_SIMILARITY_THRESHOLD } from '../src/core/facts/dedup.ts';

describe('pickDuplicate', () => {
  it('returns null for an empty candidate list', () => {
    expect(pickDuplicate([])).toBeNull();
  });

  it('returns null when the best candidate is below the threshold', () => {
    expect(pickDuplicate([{ id: 'a', similarity: DEDUP_SIMILARITY_THRESHOLD - 0.01 }])).toBeNull();
  });

  it('returns the id when the best candidate meets the threshold exactly', () => {
    expect(pickDuplicate([{ id: 'a', similarity: DEDUP_SIMILARITY_THRESHOLD }])).toBe('a');
  });

  it('returns the id when the best candidate exceeds the threshold', () => {
    expect(pickDuplicate([{ id: 'a', similarity: 0.99 }])).toBe('a');
  });

  it('only ever looks at the first (best) candidate — does not re-sort', () => {
    // A lower-similarity row placed first is trusted as the best, matching the documented contract
    // that callers pass results pre-sorted (as cycle_facts_by_entity's ORDER BY already guarantees).
    expect(pickDuplicate([
      { id: 'below-threshold', similarity: 0.5 },
      { id: 'above-threshold', similarity: 0.99 },
    ])).toBeNull();
  });
});
