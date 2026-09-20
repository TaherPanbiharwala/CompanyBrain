import { describe, expect, it } from 'bun:test';
import {
  assertLongMemEvalBudget,
  assertLongMemEvalResumeIdentity,
  completedLongMemEvalScores,
  longMemEvalSessionSlug,
  normalizeLongMemEval,
  sampleLongMemEval,
  scoreLongMemEvalCase,
  summarizeLongMemEval,
} from '../src/eval/longmemeval.ts';

const raw = [
  {
    question_id: 'q-a', question_type: 'temporal', question: 'What changed?', answer: 'A',
    haystack_session_ids: ['noise', 'gold-a', 'gold-b'],
    haystack_sessions: [[{ role: 'user', content: 'noise' }], [{ role: 'user', content: 'a' }], [{ role: 'user', content: 'b' }]],
    answer_session_ids: ['gold-a', 'gold-b'],
  },
  {
    question_id: 'q-b', question_type: 'preference', question: 'What do I prefer?', answer: 'B',
    haystack_session_ids: ['gold-c'], haystack_sessions: [[{ role: 'assistant', content: 'c' }]], answer_session_ids: ['gold-c'],
  },
] as const;

describe('LongMemEval-S normalization and scoring', () => {
  it('validates session/gold relationships before runner work', () => {
    const cases = normalizeLongMemEval(raw, 2);
    expect(cases).toHaveLength(2);
    expect(() => normalizeLongMemEval([{ ...raw[0], answer_session_ids: ['not-in-haystack'] }], 1)).toThrow('not in haystack_session_ids');
    expect(() => normalizeLongMemEval([{ ...raw[0], haystack_sessions: [] }], 1)).toThrow('sessions for 3 ids');
  });

  it('preserves published empty distractors but rejects empty gold evidence', () => {
    const withEmptyDistractor = {
      ...raw[0],
      haystack_sessions: [[], ...raw[0].haystack_sessions.slice(1)],
    };
    const [item] = normalizeLongMemEval([withEmptyDistractor], 1);
    expect(item!.sessionIds).toEqual(['noise', 'gold-a', 'gold-b']);
    expect(item!.sessions[0]).toEqual([]);
    expect(() => normalizeLongMemEval([{ ...withEmptyDistractor, answer_session_ids: ['noise'] }], 1)).toThrow('gold session noise has no turns');
  });

  it('canonicalizes identical repeated distractors and refuses conflicting repeats', () => {
    const duplicate = {
      ...raw[0],
      haystack_session_ids: ['noise', 'noise', 'gold-a'],
      haystack_sessions: [[{ role: 'user', content: 'same' }], [{ role: 'user', content: 'same' }], [{ role: 'user', content: 'a' }]],
      answer_session_ids: ['gold-a'],
    };
    const [item] = normalizeLongMemEval([duplicate], 1);
    expect(item!.sessionIds).toEqual(['noise', 'gold-a']);
    expect(() => normalizeLongMemEval([{ ...duplicate, haystack_sessions: [[{ role: 'user', content: 'first' }], [{ role: 'user', content: 'second' }], [{ role: 'user', content: 'a' }]] }], 1)).toThrow('duplicated with conflicting turns');
  });

  it('uses collision-safe case namespaced session slugs', () => {
    expect(longMemEvalSessionSlug('q-a', 'same')).not.toBe(longMemEvalSessionSlug('q-b', 'same'));
    expect(longMemEvalSessionSlug('q-a', 'same')).toBe(longMemEvalSessionSlug('q-a', 'same'));
  });

  it('is deterministic for seeded stratified sampling', () => {
    const cases = normalizeLongMemEval(raw, 2);
    expect(sampleLongMemEval(cases, 2, 42).map((item) => item.questionId)).toEqual(sampleLongMemEval(cases, 2, 42).map((item) => item.questionId));
  });

  it('requires every gold session and gives duplicate chunks no extra credit', () => {
    const [item] = normalizeLongMemEval(raw, 2);
    const partial = scoreLongMemEvalCase(item!, ['gold-a', 'gold-a', 'noise'], { latencyMs: 12 });
    expect(partial.recallAllAt5).toBe(0);
    expect(partial.anySessionRecallAt5).toBe(1);
    expect(partial.evidenceRecallAt5).toBe(0.5);
    const complete = scoreLongMemEvalCase(item!, ['gold-a', 'noise', 'gold-b'], { latencyMs: 20, degraded: true });
    const summary = summarizeLongMemEval([partial, complete]);
    expect(summary.recall_all_at_5).toBe(0.5);
    expect(summary.degraded_retrievals).toBe(1);
  });

  it('builds resumed artifacts from every checkpointed case, not just the latest sample slice', () => {
    const cases = normalizeLongMemEval(raw, 2);
    const first = scoreLongMemEvalCase(cases[0]!, ['gold-a', 'gold-b'], { latencyMs: 1 });
    const second = scoreLongMemEvalCase(cases[1]!, ['gold-c'], { latencyMs: 1 });
    expect(completedLongMemEvalScores(cases, { 'q-a': first, 'q-b': second }).map((score) => score.questionId)).toEqual(['q-a', 'q-b']);
  });

  it('denies an over-cap campaign before a provider call can be made', () => {
    expect(() => assertLongMemEvalBudget(10.01, 10)).toThrow('preflight refuses');
    expect(() => assertLongMemEvalBudget(9.99, 10)).not.toThrow();
  });

  it('refuses any changed resume identity', () => {
    // A 25-case smoke declares the full campaign universe, so a later full pass preserves the same
    // ledger identity instead of creating a second $10 budget.
    const identity = { sourceSha256: 'a', configurationHash: 'b', selectedQuestionIds: ['q-a', 'q-b'] };
    expect(() => assertLongMemEvalResumeIdentity(identity, identity)).not.toThrow();
    expect(() => assertLongMemEvalResumeIdentity(identity, { ...identity, sourceSha256: 'changed' })).toThrow('resume refused');
  });
});
