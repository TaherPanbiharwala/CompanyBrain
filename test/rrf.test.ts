import { describe, it, expect } from 'bun:test';
import { rrfFuse, RRF_K } from '../src/search/rrf.ts';

describe('rrfFuse', () => {
  it('empty input yields an empty result', () => {
    expect(rrfFuse([])).toEqual([]);
    expect(rrfFuse([[], []])).toEqual([]);
  });

  it('a single list is returned in the same order (score decreasing with rank)', () => {
    const result = rrfFuse([['a', 'b', 'c']]);
    expect(result.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(result[0]!.score).toBeGreaterThan(result[1]!.score);
    expect(result[1]!.score).toBeGreaterThan(result[2]!.score);
  });

  it('matches the hand-computed RRF formula: score = sum(1/(k+rank))', () => {
    const result = rrfFuse([['a', 'b'], ['b', 'a']], 60);
    const scoreA = 1 / (60 + 0) + 1 / (60 + 1); // rank 0 in list1, rank 1 in list2
    const scoreB = 1 / (60 + 1) + 1 / (60 + 0); // rank 1 in list1, rank 0 in list2
    const byId = new Map(result.map((r) => [r.id, r.score]));
    expect(byId.get('a')!).toBeCloseTo(scoreA, 10);
    expect(byId.get('b')!).toBeCloseTo(scoreB, 10);
    expect(byId.get('a')!).toBeCloseTo(byId.get('b')!, 10); // symmetric — a/b swap ranks across the lists
  });

  it('an id ranked #1 in every list outranks one appearing in only one list', () => {
    const result = rrfFuse([
      ['x', 'y', 'z'],
      ['x', 'z', 'y'],
    ]);
    expect(result[0]!.id).toBe('x');
  });

  it('an id absent from a list contributes nothing from that list (not treated as worst-rank)', () => {
    const onlyInOne = rrfFuse([['solo'], []]);
    const inBoth = rrfFuse([['both'], ['both']]);
    expect(inBoth[0]!.score).toBeGreaterThan(onlyInOne[0]!.score);
  });

  it('default k matches the exported RRF_K constant (gbrain standard, 60)', () => {
    expect(RRF_K).toBe(60);
    const withDefault = rrfFuse([['a']]);
    const withExplicit = rrfFuse([['a']], 60);
    expect(withDefault).toEqual(withExplicit);
  });
});

describe('rrfFuse — deterministic tie-breaking', () => {
  it('breaks exact score ties on id, not on the order the lists arrived in', () => {
    // 'a' and 'b' each hold rank 0 in one list and rank 1 in the other, so their scores are equal to
    // the last bit. Before the tie-break this returned whichever the Map saw first — i.e. the answer
    // depended on which search arm the database happened to return first.
    const forward = rrfFuse([['a', 'b'], ['b', 'a']]);
    const reversed = rrfFuse([['b', 'a'], ['a', 'b']]);
    expect(forward.map((r) => r.id)).toEqual(['a', 'b']);
    expect(reversed.map((r) => r.id)).toEqual(['a', 'b']); // same answer either way
    expect(forward[0]!.score).toBe(forward[1]!.score); // genuinely tied, not ordered by score
  });

  it('score still dominates the tie-break', () => {
    // 'z' sorts after 'a' alphabetically but outranks it, so id must never override score.
    const result = rrfFuse([['z', 'a'], ['z', 'a']]);
    expect(result.map((r) => r.id)).toEqual(['z', 'a']);
  });
});
