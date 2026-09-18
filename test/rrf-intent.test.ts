import { describe, expect, it } from 'bun:test';
import { RRF_K, rrfFusePerList, rrfFuseWeighted } from '../src/search/rrf.ts';

describe('intent-adjusted per-list RRF', () => {
  it('is backward-equivalent when every list uses the shared k', () => {
    const lists = [['a', 'b'], ['b', 'c']] as const;
    const weights = [1, 0.4] as const;
    expect(rrfFusePerList([
      { ids: lists[0], weight: weights[0], k: RRF_K },
      { ids: lists[1], weight: weights[1], k: RRF_K },
    ])).toEqual(rrfFuseWeighted(lists, weights));
  });

  it('uses an independent effective k while retaining base arm weights', () => {
    const [result] = rrfFusePerList([
      { ids: ['same'], weight: 1, k: 60 / 1.2 },
      { ids: ['same'], weight: 0.5, k: 60 / 0.9 },
    ]);
    expect(result!.score).toBeCloseTo(1 / 50 + 0.5 / (60 / 0.9), 12);
  });

  it('keeps deterministic id ties', () => {
    expect(rrfFusePerList([{ ids: ['b', 'a'], weight: 1, k: 60 }, { ids: ['a', 'b'], weight: 1, k: 60 }])
      .map((row) => row.id)).toEqual(['a', 'b']);
  });
});
