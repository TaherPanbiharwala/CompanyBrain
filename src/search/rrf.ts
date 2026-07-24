// Reciprocal Rank Fusion. Formula and constant ported from gbrain's src/core/search/hybrid.ts
// (RRF_K = 60, rrfFusion/rrfFusionWeighted) under MIT — see NOTICE. Simplified for the A17 spike:
// no per-list weighting, boosts, or intent-weighted k — just the standard fusion formula, since the
// spike has exactly two arms (keyword, vector) of equal standing.
export const RRF_K = 60;

export interface RrfResult {
  id: string;
  score: number;
}

/** Fuse N ranked id lists into one ranked list via score = sum(1 / (k + rank)) per list,
 *  rank 0-indexed. An id absent from a list contributes nothing from that list. */
export function rrfFuse(rankedLists: readonly (readonly string[])[], k: number = RRF_K): RrfResult[] {
  const scores = new Map<string, number>();
  for (const list of rankedLists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
