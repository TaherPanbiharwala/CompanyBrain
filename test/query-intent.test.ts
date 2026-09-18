import { describe, expect, it } from 'bun:test';
import { classifyQuery, classifyQueryIntent, isConceptShapedQuery } from '../src/search/query-intent.ts';

describe('gbrain-pinned query intent', () => {
  it.each([
    ['give me everything about Acme', 'temporal'],
    ['when was the last meeting with Acme?', 'temporal'],
    ['Acme announced its IPO', 'event'],
    ['What is the ownership economy?', 'concept'],
    ['who is garry tan', 'entity'],
    ['quarterly planning notes', 'general'],
  ] as const)('%s → %s', (query, intent) => {
    expect(classifyQueryIntent(query)).toBe(intent);
  });

  it('pins overlapping priority: full-context, temporal, event, concept, entity, general', () => {
    expect(classifyQueryIntent('tell me everything about the launch')).toBe('temporal');
    expect(classifyQueryIntent('when was the launch announced?')).toBe('temporal');
    expect(classifyQueryIntent('what is the launch announcement?')).toBe('event');
    expect(classifyQueryIntent('what is the ownership economy?')).toBe('concept');
  });

  it('keeps exact identifiers, proper nouns, and status verbs out of concept', () => {
    for (const query of [
      'what is "ownership economy" about',
      'what is ownership-economy about',
      'what is the Acme platform',
      'what is saoirse working on',
    ]) {
      expect(isConceptShapedQuery(query)).toBe(false);
      expect(classifyQueryIntent(query)).toBe('entity');
    }
  });

  it('is stable across casing and punctuation', () => {
    expect(classifyQueryIntent('WHO IS GARRY TAN?')).toBe('entity');
    expect(classifyQueryIntent('LATEST: what happened?')).toBe('temporal');
  });

  it('uses canonical suppression before strong/moderate recency', () => {
    expect(classifyQuery('who is Acme currently')).toEqual({
      intent: 'entity', suggestedRecency: 'off', recencySuppressed: true,
    });
    expect(classifyQuery('who is Acme right now')).toEqual({
      intent: 'entity', suggestedRecency: 'strong', recencySuppressed: false,
    });
    expect(classifyQuery('what is new today')).toEqual({
      intent: 'temporal', suggestedRecency: 'strong', recencySuppressed: false,
    });
    expect(classifyQuery('catch me up on Acme')).toEqual({
      intent: 'general', suggestedRecency: 'on', recencySuppressed: false,
    });
  });
});
