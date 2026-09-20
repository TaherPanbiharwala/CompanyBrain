import { describe, expect, it } from 'bun:test';
import {
  buildFactExtractionMessages,
  parseFactExtractionResponse,
  FACT_EXTRACTION_MAX_CHARS,
  MAX_FACTS_PER_CALL,
} from '../src/core/facts/extract.ts';

const PAGE = { title: 'Q3 Board Deck', slug: 'q3-board-deck', kind: 'note', tags: ['finance'] };

describe('buildFactExtractionMessages', () => {
  it('includes page metadata and the body text', () => {
    const messages = buildFactExtractionMessages(PAGE, 'MRR grew to $40k in Q3.');
    expect(messages[0]!.role).toBe('system');
    expect(messages[1]!.content).toContain('Q3 Board Deck');
    expect(messages[1]!.content).toContain('finance');
    expect(messages[1]!.content).toContain('MRR grew to $40k in Q3.');
  });

  it('truncates at FACT_EXTRACTION_MAX_CHARS and marks the truncation visibly', () => {
    const long = 'x'.repeat(FACT_EXTRACTION_MAX_CHARS + 500);
    const messages = buildFactExtractionMessages(PAGE, long);
    const body = messages[1]!.content;
    expect(body).toContain('[document truncated]');
    expect(body.length).toBeLessThan(long.length);
  });

  it('does not mark truncation when the text fits', () => {
    const messages = buildFactExtractionMessages(PAGE, 'short body');
    expect(messages[1]!.content).not.toContain('[document truncated]');
  });
});

describe('parseFactExtractionResponse', () => {
  it('parses a well-formed response', () => {
    const raw = JSON.stringify({
      facts: [
        {
          entity: 'Acme Corp',
          kind: 'fact',
          notability: 'high',
          confidence: 0.9,
          claim_text: 'Acme Corp raised a Series A.',
          source_excerpt: 'Acme Corp closed its Series A round.',
        },
      ],
    });
    const { facts, parseFailed } = parseFactExtractionResponse(raw);
    expect(parseFailed).toBe(false);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      entitySlug: 'acme-corp',
      kind: 'fact',
      notability: 'high',
      confidence: 0.9,
      claimText: 'Acme Corp raised a Series A.',
    });
  });

  it('strips a ```json fence before parsing', () => {
    const raw = '```json\n' + JSON.stringify({ facts: [] }) + '\n```';
    const { facts, parseFailed } = parseFactExtractionResponse(raw);
    expect(parseFailed).toBe(false);
    expect(facts).toEqual([]);
  });

  it('a totally malformed response degrades to zero facts, parseFailed:true', () => {
    const { facts, parseFailed } = parseFactExtractionResponse('not json at all');
    expect(parseFailed).toBe(true);
    expect(facts).toEqual([]);
  });

  it('a response with the wrong top-level shape degrades to zero facts, parseFailed:true', () => {
    const { facts, parseFailed } = parseFactExtractionResponse(JSON.stringify({ answer: 'not facts' }));
    expect(parseFailed).toBe(true);
    expect(facts).toEqual([]);
  });

  it('one malformed fact in an otherwise-valid array is dropped, not the whole response', () => {
    const raw = JSON.stringify({
      facts: [
        { claim_text: 'a valid claim' }, // valid: only claim_text is required
        { claim_text: '' }, // invalid: empty string fails min(1)
        { entity: 'x' }, // invalid: missing required claim_text
      ],
    });
    const { facts, parseFailed } = parseFactExtractionResponse(raw);
    expect(parseFailed).toBe(false);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.claimText).toBe('a valid claim');
  });

  it('an unrecognized kind/notability falls back to safe defaults rather than being dropped', () => {
    const raw = JSON.stringify({
      facts: [{ claim_text: 'x', kind: 'prediction', notability: 'critical' }],
    });
    const { facts } = parseFactExtractionResponse(raw);
    expect(facts[0]!.kind).toBe('fact');
    expect(facts[0]!.notability).toBe('medium');
  });

  it('confidence is clamped to [0, 1]', () => {
    const raw = JSON.stringify({
      facts: [
        { claim_text: 'a', confidence: 5 },
        { claim_text: 'b', confidence: -2 },
      ],
    });
    const { facts } = parseFactExtractionResponse(raw);
    expect(facts[0]!.confidence).toBe(1);
    expect(facts[1]!.confidence).toBe(0);
  });

  it('event_type is dropped for a non-event kind even if the model supplied one', () => {
    const raw = JSON.stringify({
      facts: [{ claim_text: 'a', kind: 'fact', event_type: 'meeting' }],
    });
    const { facts } = parseFactExtractionResponse(raw);
    expect(facts[0]!.eventType).toBeNull();
  });

  it('a model that ignores the advisory cap is truncated to MAX_FACTS_PER_CALL, not rejected', () => {
    const raw = JSON.stringify({
      facts: Array.from({ length: 30 }, (_, i) => ({ claim_text: `claim ${i}` })),
    });
    const { facts, parseFailed } = parseFactExtractionResponse(raw);
    expect(parseFailed).toBe(false);
    expect(facts).toHaveLength(MAX_FACTS_PER_CALL);
  });

  it('an entity string that normalizes to nothing becomes a null entitySlug, not a crash', () => {
    const raw = JSON.stringify({ facts: [{ claim_text: 'a', entity: '!!!' }] });
    const { facts } = parseFactExtractionResponse(raw);
    expect(facts[0]!.entitySlug).toBeNull();
  });

  it('different spellings of the same entity normalize to the same slug', () => {
    const raw = JSON.stringify({
      facts: [
        { claim_text: 'a', entity: 'Acme Corp' },
        { claim_text: 'b', entity: 'ACME CORP.' },
      ],
    });
    const { facts } = parseFactExtractionResponse(raw);
    expect(facts[0]!.entitySlug).toBe(facts[1]!.entitySlug);
  });
});
