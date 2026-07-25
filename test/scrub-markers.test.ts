// scrubMarkers guards the PROSE a human reads; the citation clamp guards the array. They are separate
// channels and both have shipped bugs, so this pins the prose side directly instead of only through
// answerQuestion — which needs a live database and a model call, and is why the digit-range bug below
// went unnoticed.
import { describe, it, expect } from 'bun:test';
import { scrubMarkers } from '../src/answer/answer.ts';

describe('scrubMarkers', () => {
  it('keeps markers that point at real evidence', () => {
    expect(scrubMarkers('Revenue grew [1] and headcount doubled [8].', 8))
      .toBe('Revenue grew [1] and headcount doubled [8].');
  });

  it('removes markers past the end of the evidence', () => {
    expect(scrubMarkers('a [9] b', 8)).toBe('a  b');
    expect(scrubMarkers('a [0] b', 8)).toBe('a  b'); // 0 is not a 1-based index
  });

  it('removes an out-of-range marker of ANY length — the regression that shipped', () => {
    // The pattern was \d{1,4}, so a five-digit marker never entered the range check at all and was
    // returned verbatim under a test titled "no dangling footnote, ever". A poisoned page only had to
    // ask the model for a big number.
    for (const n of ['9999', '10000', '12345', '999999999', '1000000000000000000000']) {
      expect(scrubMarkers(`x [${n}] y`, 8)).toBe('x  y');
    }
  });

  it('does not touch text that is not a well-formed marker, and never FABRICATES one', () => {
    // Nested/unbalanced brackets must pass through rather than be rewritten into a valid marker — a
    // scrub that turns `[1[2]]` into `[1]` would invent a citation, which is worse than missing one.
    for (const s of ['x [1[2]] y', '[[3]]', 'see [a] and [1.5] and [ 1 ]']) {
      expect(scrubMarkers(s, 8)).toBe(s);
    }
  });

  it('KNOWN false positive, accepted: bracketed indices in quoted code are scrubbed', () => {
    // `array[0]` is a well-formed [digits] token and 0 is not a valid 1-based citation, so it goes.
    // Recorded rather than fixed: this operates on prose the model wrote about the evidence, a
    // dangling footnote is a correctness problem while a mangled code snippet is a cosmetic one, and
    // distinguishing them needs to know whether we are inside a code fence. Revisit if `ask` starts
    // being used to quote source code.
    expect(scrubMarkers('array[0] index', 8)).toBe('array index');
    expect(scrubMarkers('items[3] is fine', 8)).toBe('items[3] is fine'); // in range, so it stays
  });

  it('with zero sources, every marker is dangling', () => {
    expect(scrubMarkers('a [1] b [2] c', 0)).toBe('a  b  c');
  });
});
