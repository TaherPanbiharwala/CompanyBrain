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
