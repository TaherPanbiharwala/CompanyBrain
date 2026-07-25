// The retrieval scorer — the numbers the A17 go/no-go rests on.
//
// No test file imported this module before the M1+M2 review; the only consumer is
// scripts/run-a17-eval.ts, whose output is `eval/a17-report.md` — the evidence used to decide
// whether the answer-quality bet holds. Every line here is off-by-one-prone (`=== 0`, `< 3`,
// `1 / (i + 1)`, a `|| 1` divide-guard), and a scorer that reports optimistic numbers is strictly
// worse than no scorer, because a milestone decision is made on its output and nothing else checks
// it. Hand-computed expectations throughout — a test that re-derives the formula proves nothing.
import { describe, it, expect } from 'bun:test';
import { scoreQuestion, scoreRetrieval, type QrelQuestion } from '../src/search/eval-score.ts';

const q: QrelQuestion = { id: 'q1', question: 'x', relevantSlugs: ['a', 'b'] };

describe('scoreQuestion — every rank boundary, computed by hand', () => {
  it('relevant at rank 0 → hit@1, hit@3, RR = 1', () => {
    expect(scoreQuestion(q, ['a', 'z', 'y'])).toEqual({ id: 'q1', hitAt1: true, hitAt3: true, reciprocalRank: 1 });
  });

  it('rank 1 → not hit@1, still hit@3, RR = 1/2', () => {
    expect(scoreQuestion(q, ['z', 'a'])).toEqual({ id: 'q1', hitAt1: false, hitAt3: true, reciprocalRank: 0.5 });
  });

  it('rank 2 is the LAST position that counts as hit@3 (RR = 1/3)', () => {
    expect(scoreQuestion(q, ['z', 'y', 'b'])).toEqual({ id: 'q1', hitAt1: false, hitAt3: true, reciprocalRank: 1 / 3 });
  });

  it('rank 3 is the FIRST miss@3 — but RR is still 1/4, not 0', () => {
    // The off-by-one that would silently inflate hit@3: `<= 3` instead of `< 3`.
    expect(scoreQuestion(q, ['z', 'y', 'x', 'b'])).toEqual({ id: 'q1', hitAt1: false, hitAt3: false, reciprocalRank: 0.25 });
  });

  it('no relevant slug anywhere → RR 0, never NaN and never 1', () => {
    // findIndex returns -1; `1 / (-1 + 1)` would be Infinity, and `-1 < 3` would be a false hit@3.
    expect(scoreQuestion(q, ['z', 'y'])).toEqual({ id: 'q1', hitAt1: false, hitAt3: false, reciprocalRank: 0 });
  });

  it('an EMPTY ranked list is a miss, not a hit@1', () => {
    expect(scoreQuestion(q, [])).toEqual({ id: 'q1', hitAt1: false, hitAt3: false, reciprocalRank: 0 });
  });

  it('any relevant slug counts, and the EARLIEST one wins', () => {
    // 'b' at rank 1 beats 'a' at rank 2 — the scorer must not privilege relevantSlugs order.
    expect(scoreQuestion(q, ['z', 'b', 'a']).reciprocalRank).toBe(0.5);
  });

  it('a question with NO relevant slugs can never score a hit', () => {
    const none: QrelQuestion = { id: 'q0', question: 'x', relevantSlugs: [] };
    expect(scoreQuestion(none, ['a', 'b', 'c'])).toEqual({ id: 'q0', hitAt1: false, hitAt3: false, reciprocalRank: 0 });
  });

  it('duplicates in the ranked list do not shift the rank of the first hit', () => {
    expect(scoreQuestion(q, ['z', 'z', 'a']).reciprocalRank).toBe(1 / 3);
  });
});

describe('scoreRetrieval — aggregate arithmetic', () => {
  it('rates are hits/questions and mrr is the mean RR', async () => {
    const qrels: QrelQuestion[] = [
      { id: '1', question: 'first', relevantSlugs: ['a'] },
      { id: '2', question: 'second', relevantSlugs: ['b'] },
    ];
    // 'first' hits at rank 0 (RR 1); 'second' hits at rank 1 (RR 1/2).
    const s = await scoreRetrieval(qrels, async (question) => (question === 'first' ? ['a'] : ['x', 'b']));

    expect(s.questionCount).toBe(2);
    expect(s.hitAt1Rate).toBe(0.5); // one of two
    expect(s.hitAt3Rate).toBe(1); // both
    expect(s.mrr).toBeCloseTo(0.75, 10); // (1 + 0.5) / 2
    expect(s.perQuestion.map((p) => p.id)).toEqual(['1', '2']); // order preserved
  });

  it('empty qrels → zeros, never NaN (the `length || 1` guard, asserted)', async () => {
    const s = await scoreRetrieval([], async () => []);
    expect(s.questionCount).toBe(0);
    expect(Number.isNaN(s.mrr)).toBe(false);
    expect(s.mrr).toBe(0);
    expect(s.hitAt1Rate).toBe(0);
    expect(s.hitAt3Rate).toBe(0);
    expect(s.perQuestion).toEqual([]);
  });

  it('a total miss across every question scores 0, not NaN', async () => {
    const s = await scoreRetrieval(
      [{ id: '1', question: 'a', relevantSlugs: ['x'] }, { id: '2', question: 'b', relevantSlugs: ['y'] }],
      async () => ['nope'],
    );
    expect(s.hitAt1Rate).toBe(0);
    expect(s.mrr).toBe(0);
  });

  it('a perfect run scores exactly 1 on every metric', async () => {
    const s = await scoreRetrieval(
      [{ id: '1', question: 'a', relevantSlugs: ['a'] }, { id: '2', question: 'b', relevantSlugs: ['b'] }],
      async (question) => [question],
    );
    expect(s.hitAt1Rate).toBe(1);
    expect(s.hitAt3Rate).toBe(1);
    expect(s.mrr).toBe(1);
  });

  it('questionCount reflects the qrels, so a rate can never exceed 1', async () => {
    const qrels = Array.from({ length: 7 }, (_, i) => ({ id: String(i), question: 'a', relevantSlugs: ['a'] }));
    const s = await scoreRetrieval(qrels, async () => ['a']);
    expect(s.questionCount).toBe(7);
    expect(s.hitAt1Rate).toBe(1);
    expect(s.perQuestion).toHaveLength(7);
  });
});
