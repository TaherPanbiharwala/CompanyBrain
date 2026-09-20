// Fact dedup decision (M10 wave 1). Pure — the actual cosine ranking happens in SQL, against the
// HNSW index, via cb_internal.cycle_facts_by_entity (which returns candidates already ordered by
// similarity descending). This module only decides what to do with that ranked list, so the decision
// itself is unit-testable without a database.
//
// Matches gbrain's actually-shipped dedup path, not its dead-code LLM-judge triadic classifier
// (duplicate/supersede/independent) — see DECISIONS.md D114. Cosine-only, entity-scoped, one
// threshold. A hit is recorded via consolidated_at/consolidated_into rather than silently dropped;
// there is no "supersede" outcome in this build.

export const DEDUP_SIMILARITY_THRESHOLD = 0.95;

export interface SimilarFactCandidate {
  id: string;
  similarity: number;
}

/** Returns the id to consolidate into, or null when nothing in `candidates` is similar enough to
 *  count as a duplicate. `candidates` is expected pre-sorted by similarity descending (as
 *  cycle_facts_by_entity returns it); this does not re-sort, only checks the best candidate. */
export function pickDuplicate(candidates: readonly SimilarFactCandidate[]): string | null {
  const best = candidates[0];
  if (!best) return null;
  return best.similarity >= DEDUP_SIMILARITY_THRESHOLD ? best.id : null;
}
