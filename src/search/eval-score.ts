// Retrieval-quality scoring. Engine-agnostic callback pattern ported from gbrain's
// src/eval/retrieval-quality/harness.ts (NamedThingBench) under MIT — see NOTICE. Simplified for
// the A17 spike: hit@1/hit@3/MRR only (no failure-class families, no hard-negative precision guard
// — those are legitimate M3 hardening once there's a real corpus and query taxonomy to justify them).
export interface QrelQuestion {
  id: string;
  question: string;
  relevantSlugs: string[];
}

export interface QuestionScore {
  id: string;
  hitAt1: boolean;
  hitAt3: boolean;
  reciprocalRank: number; // 0 if no relevant slug appears in the ranked results
}

export interface RetrievalScoreSummary {
  questionCount: number;
  hitAt1Rate: number;
  hitAt3Rate: number;
  mrr: number;
  perQuestion: QuestionScore[];
}

export function scoreQuestion(q: QrelQuestion, rankedSlugs: readonly string[]): QuestionScore {
  const relevant = new Set(q.relevantSlugs);
  const firstHitIndex = rankedSlugs.findIndex((slug) => relevant.has(slug));
  return {
    id: q.id,
    hitAt1: firstHitIndex === 0,
    hitAt3: firstHitIndex !== -1 && firstHitIndex < 3,
    reciprocalRank: firstHitIndex === -1 ? 0 : 1 / (firstHitIndex + 1),
  };
}

/** searchFn maps a question to its ranked list of page slugs (best match first). */
export async function scoreRetrieval(
  qrels: readonly QrelQuestion[],
  searchFn: (question: string) => Promise<string[]>,
): Promise<RetrievalScoreSummary> {
  const perQuestion: QuestionScore[] = [];
  for (const q of qrels) {
    const ranked = await searchFn(q.question);
    perQuestion.push(scoreQuestion(q, ranked));
  }
  const n = perQuestion.length || 1;
  return {
    questionCount: perQuestion.length,
    hitAt1Rate: perQuestion.filter((s) => s.hitAt1).length / n,
    hitAt3Rate: perQuestion.filter((s) => s.hitAt3).length / n,
    mrr: perQuestion.reduce((sum, s) => sum + s.reciprocalRank, 0) / n,
    perQuestion,
  };
}

// ── Multi-hop scoring ───────────────────────────────────────────────────────
//
// STRICTLY ADDITIVE. Nothing above this line changes signature: scripts/novabyte-eval.ts pins
// `scoreRetrieval`'s return type with a conditional-type expression, and `scripts/` is inside the
// tsconfig `include`, so altering it fails `bun run typecheck` — CI's first step.
//
// WHY THE EXISTING METRICS ARE NOT ENOUGH. hit@1/hit@3/MRR all answer "did ANY relevant document
// appear". For a question that needs four documents to answer, retrieving one of them is not a
// partial success, it is a failure that scores as a win. Questions here need 2-4 documents (mean
// 2.62 on MultiHop-RAG), so the bar has to be "all of them, within k".

export interface MultiHopScoreAtK {
  k: number;
  /**
   * 1 when every gold document appears within the first k chunks, else 0. The multi-hop bar.
   *
   * `null` — never 1 — when the question has NO gold documents. The empty set is technically a
   * subset of everything, so the natural implementation scores every unanswerable question a perfect
   * 1.0 and silently inflates the headline metric by the size of the null suite (301 of 2,556 here,
   * ~12%). Recall over no relevant documents is undefined, and it says so.
   */
  allEvidenceRecall: number | null;
  /** Fraction of gold documents found within k. `null` for the same reason (it would be 0/0). */
  evidenceRecall: number | null;
  hitAt1: boolean;
  reciprocalRank: number;
  /** Distinct documents the k chunks span. MAX_PER_PAGE=3 floors this at ceil(k/3); the gap between
   *  that floor and k is how much of the context budget went to redundant chunks of one document. */
  distinctDocs: number;
}

export interface MultiHopScore {
  perK: MultiHopScoreAtK[];
  /** Distinct documents across the whole ranked list, before any k slice. */
  distinctDocsTotal: number;
}

/** First index at which any gold slug appears, over the DEDUPED document order. -1 if absent. */
function firstGoldIndex(gold: ReadonlySet<string>, docsInRankOrder: readonly string[]): number {
  return docsInRankOrder.findIndex((slug) => gold.has(slug));
}

/**
 * Score one question's ranked CHUNK list at several cutoffs.
 *
 * `rankedSlugs` is per-chunk and may repeat a slug — that is the raw shape `hybridSearch` returns,
 * and deduping is done here rather than by the caller so it cannot be forgotten at one call site
 * and not another. `k` counts CHUNKS, matching `DEFAULT_TOP_K`, because that is the unit the
 * pipeline's context budget is actually spent in.
 */
export function scoreMultiHop(
  gold: ReadonlySet<string>,
  rankedSlugs: readonly string[],
  ks: readonly number[],
): MultiHopScore {
  const perK: MultiHopScoreAtK[] = ks.map((k) => {
    // A k larger than the list is not an error — it means "everything retrieved". What it must NOT
    // do is pretend k results existed: distinctDocs counts what is actually there.
    const window = rankedSlugs.slice(0, k);
    const docs = [...new Set(window)];
    const found = [...gold].filter((slug) => docs.includes(slug)).length;
    const idx = firstGoldIndex(gold, docs);
    return {
      k,
      allEvidenceRecall: gold.size === 0 ? null : found === gold.size ? 1 : 0,
      evidenceRecall: gold.size === 0 ? null : found / gold.size,
      hitAt1: idx === 0,
      reciprocalRank: idx === -1 ? 0 : 1 / (idx + 1),
      distinctDocs: docs.length,
    };
  });
  return { perK, distinctDocsTotal: new Set(rankedSlugs).size };
}

/**
 * Was every gold document present in the PRE-FUSION candidate pool?
 *
 * This is the metric that makes a flat recall curve interpretable. Every retrieval arm is capped
 * independently of topK (the baseline candidatePool vector/AND/OR/title limits are 20/20/10/10), so fusion
 * never sees more than ~60 candidates at any k. Without this number, "recall did not improve as k
 * grew" is equally consistent with two causes that have opposite fixes:
 *
 *   candidate recall HIGH -> the gold chunk was found and ranked badly. Fix ranking (reranker,
 *                            embeddings, weights). Costs money.
 *   candidate recall LOW  -> the gold chunk never entered the pool at all. Raise the arm limits.
 *                            Free, DB-side, and no amount of reranking would have helped.
 *
 * `null` when the question has no gold documents, for the same reason as above.
 */
export function scoreCandidateRecall(
  gold: ReadonlySet<string>,
  candidateSlugs: readonly string[],
): number | null {
  if (gold.size === 0) return null;
  const pool = new Set(candidateSlugs);
  const found = [...gold].filter((slug) => pool.has(slug)).length;
  return found / gold.size;
}
