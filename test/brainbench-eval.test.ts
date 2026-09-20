import { describe, expect, it } from 'bun:test';
import {
  firstPageOccurrences,
  normalizeAmaraManifest,
  normalizeBrainBenchQueries,
  partitionBrainBenchGoldBearingQueries,
  normalizeWorldPage,
  parseAmaraCalendar,
  scoreBrainBenchQuery,
  summarizeBrainBenchRuns,
  worldPageBody,
} from '../src/eval/brainbench.ts';

describe('BrainBench public corpus boundary', () => {
  it('constructs SUT page input from title, compiled_truth, and timeline only', () => {
    const page = normalizeWorldPage({ slug: 'people/a', title: 'A', compiled_truth: 'PUBLIC', timeline: 'TIME', _facts: 'SECRET QREL ONLY' });
    const body = worldPageBody(page);
    expect(body).toContain('PUBLIC');
    expect(body).toContain('TIME');
    expect(body).not.toContain('SECRET QREL ONLY');
  });

  it('rejects a qrel that points outside public world pages', () => {
    expect(() => normalizeBrainBenchQueries([{ id: 'q', question: 'where?', gold: { relevant: ['missing'] } }], 'relational', new Set(['people/a']))).toThrow('unknown public page');
  });

  it('accepts the documented query_id/relevant_slugs qrel spelling without relaxing page validation', () => {
    expect(normalizeBrainBenchQueries([{ query_id: 'q', query: 'where?', relevant_slugs: ['people/a'] }], 'relational', new Set(['people/a']))).toEqual([
      { id: 'q', family: 'relational', text: 'where?', relevantSlugs: ['people/a'] },
    ]);
  });

  it('excludes only explicitly marked abstention rows from the retrieval denominator', () => {
    const partition = partitionBrainBenchGoldBearingQueries([
      { id: 'scored', question: 'where?', gold: { relevant: ['people/a'] } },
      { id: 'abstain', question: 'unknown?', gold: { expected_abstention: true } },
    ], 'fuzzy');
    expect(partition.excludedAbstentionQueryIds).toEqual(['abstain']);
    expect(normalizeBrainBenchQueries(partition.candidates, 'fuzzy', new Set(['people/a']))).toHaveLength(1);
    expect(() => partitionBrainBenchGoldBearingQueries([{ id: 'bad', gold: { expected_abstention: true, relevant: ['people/a'] } }], 'fuzzy')).toThrow('unexpectedly has retrieval qrels');
  });
});

describe('BrainBench page ranking and scoring', () => {
  it('dedupes chunks by first page occurrence before a page-level top five score', () => {
    expect(firstPageOccurrences(['a', 'a', 'b', 'c', 'c', 'd', 'e', 'f'])).toEqual(['a', 'b', 'c', 'd', 'e']);
    const score = scoreBrainBenchQuery({ id: 'q', family: 'relational', text: 'x', relevantSlugs: ['b', 'e'] }, ['a', 'a', 'b', 'c', 'd', 'e'], { latencyMs: 10 });
    expect(score.precisionAt5).toBe(0.4);
    expect(score.recallAt5).toBe(1);
    expect(score.reciprocalRank).toBe(0.5);
  });

  it('keeps error queries in the denominator and requires exactly five runs', () => {
    const one = { denominator: 1, precision_at_5: 0, recall_at_5: 0, mrr: 0, p50_latency_ms: 1, p95_latency_ms: 1, errors: 1, degraded_retrievals: 0 };
    expect(() => summarizeBrainBenchRuns([one, one, one, one])).toThrow('exactly five');
    expect(summarizeBrainBenchRuns([one, one, one, one, one]).errors.mean).toBe(1);
  });
});

describe('Amara parser', () => {
  it('validates manifest hashes and splits individual VEVENTs deterministically', () => {
    expect(normalizeAmaraManifest({ items: [{ slug: 'cal/evt-1', path: 'calendar.ics', type: 'calendar-event', content_sha256: 'a'.repeat(64) }] })).toHaveLength(1);
    const events = parseAmaraCalendar('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:evt-1@example.com\nSUMMARY:Board\nEND:VEVENT\nEND:VCALENDAR\n');
    expect(events).toEqual([{ slug: 'cal/evt-1', title: 'Board', body: 'BEGIN:VEVENT\nUID:evt-1@example.com\nSUMMARY:Board\nEND:VEVENT', source: 'BEGIN:VEVENT\nUID:evt-1@example.com\nSUMMARY:Board\nEND:VEVENT' }]);
  });
});
