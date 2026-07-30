// Reciprocal Rank Fusion. Formula and constant ported from gbrain's src/core/search/hybrid.ts
// (RRF_K = 60, rrfFusion/rrfFusionWeighted) under MIT — see NOTICE. Per-list weighting is now
// ported too (rrfFuseWeighted below); hybridSearch fuses FOUR weighted arms (kw_and, kw_or, vec,
// title). Boosts and intent-weighted k remain unported.
export const RRF_K = 60;

export interface RrfResult {
  id: string;
  score: number;
}

/** Fuse N ranked id lists into one ranked list via score = sum(1 / (k + rank)) per list,
 *  rank 0-indexed. An id absent from a list contributes nothing from that list. */
export function rrfFuse(rankedLists: readonly (readonly string[])[], k: number = RRF_K): RrfResult[] {
  return rrfFuseWeighted(rankedLists, rankedLists.map(() => 1), k);
}

/** Weighted RRF: score = sum(weight_i / (k + rank)) over the lists an id appears in.
 *
 *  gbrain had `rrfFusionWeighted` and the A17 port dropped it, which is why the four arms in
 *  hybridSearch could not be given different standing — a title match counted exactly as much as a
 *  vector hit. Added rather than replacing `rrfFuse` (D65: extend, don't replace) so the unweighted
 *  behaviour every existing test pins stays byte-identical, expressed as the all-weights-1 case.
 *
 *  `weights` is POSITIONAL against `rankedLists`, and the two must stay in the same order as the
 *  union in hybridSearch's SQL. A transposed weight vector is invisible to the equivalence test —
 *  both sides would be equally wrong — so the ordering is asserted by neither and must be read. */
export function rrfFuseWeighted(
  rankedLists: readonly (readonly string[])[],
  weights: readonly number[],
  k: number = RRF_K,
): RrfResult[] {
  if (weights.length !== rankedLists.length) {
    throw new Error(`rrfFuseWeighted: ${rankedLists.length} lists but ${weights.length} weights`);
  }
  const scores = new Map<string, number>();
  rankedLists.forEach((list, i) => {
    const weight = weights[i]!;
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + weight / (k + rank));
    });
  });
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    // Tie-break on id, not on Map insertion order. RRF ties are COMMON — any two ids holding the
    // same rank in the same number of lists score identically — and relying on insertion order made
    // the result depend on which arm happened to return first. It also made this function impossible
    // to compare against an equivalent SQL ordering, which is now how hybridSearch fuses (one round
    // trip instead of two); test/rrf.test.ts pins the tie-break, and the live search test asserts
    // the SQL agrees with this implementation.
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
