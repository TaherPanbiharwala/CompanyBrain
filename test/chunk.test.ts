import { describe, it, expect } from 'bun:test';
import { chunkText } from '../src/ingest/chunk.ts';

describe('chunkText', () => {
  it('empty/whitespace-only input returns no chunks (does not throw)', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  it('short text (under chunkSize words) stays a single chunk', () => {
    const text = 'This is a short paragraph. It has a few sentences. Nothing fancy here.';
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe(text);
    expect(chunks[0]!.index).toBe(0);
  });

  it('long text splits into multiple chunks near the target size', () => {
    const sentence = 'The quick brown fox jumps over the lazy dog near the riverbank each morning. ';
    const text = sentence.repeat(120); // ~1440 words, well over the 300-word default
    const chunks = chunkText(text, { chunkSize: 100, chunkOverlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it('overlap actually duplicates content at chunk boundaries (not a no-op)', () => {
    const sentence = 'The quick brown fox jumps over the lazy dog near the riverbank each morning. ';
    const text = sentence.repeat(120);
    const noOverlap = chunkText(text, { chunkSize: 100, chunkOverlap: 0 });
    const withOverlap = chunkText(text, { chunkSize: 100, chunkOverlap: 20 });
    const lenNoOverlap = noOverlap.reduce((sum, c) => sum + c.text.length, 0);
    const lenWithOverlap = withOverlap.reduce((sum, c) => sum + c.text.length, 0);
    // overlap duplicates trailing content into the next chunk, so the concatenated length with
    // overlap must strictly exceed the no-overlap concatenation — a broken/no-op overlap
    // implementation would make these equal.
    expect(withOverlap.length).toBeGreaterThan(1);
    expect(lenWithOverlap).toBeGreaterThan(lenNoOverlap);
  });

  it('the char-slice fallback is LOSSLESS and capped on whitespace-less input', () => {
    // The fixture is the test. `'x'.repeat(20000)` makes losslessness unverifiable IN PRINCIPLE —
    // every slice of it looks like every other, so a chunker that silently dropped 3000 chars would
    // still pass. Position-encoded blocks (no whitespace, so still the char-slice path) make each
    // slice uniquely locatable, which is what turns the stated property into an assertion.
    let text = '';
    for (let i = 0; text.length < 20000; i++) text += `[${i.toString(36).padStart(6, '0')}]`;

    const chunks = chunkText(text, { maxChars: 6000 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(6000);

    // Walk the chunks in order, locating each in the original. `covered` is how far the union of
    // chunks reaches: a chunk starting past it is a GAP (dropped content), and a chunk that is not
    // found at all is INVENTED content.
    let covered = 0;
    for (const c of chunks) {
      const at = text.indexOf(c.text);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThanOrEqual(covered);
      covered = Math.max(covered, at + c.text.length);
    }
    expect(covered).toBe(text.length);
  });

  it('an explicit chunkOverlap of 0 means NO overlap (0 is not "unset")', () => {
    const sentence = 'The quick brown fox jumps over the lazy dog near the riverbank each morning. ';
    const text = sentence.repeat(120);
    const zeroOverlap = chunkText(text, { chunkSize: 100, chunkOverlap: 0 });
    const defaultOverlap = chunkText(text, { chunkSize: 100 }); // omitted -> real default (50)
    const lenZero = zeroOverlap.reduce((sum, c) => sum + c.text.length, 0);
    const lenDefault = defaultOverlap.reduce((sum, c) => sum + c.text.length, 0);
    // a `|| 50`-style bug would silently treat 0 as "use the default," making these equal.
    expect(lenZero).toBeLessThan(lenDefault);
  });

  it('a body just over the target size still produces a bounded, non-empty chunk set', () => {
    const text = Array.from({ length: 310 }, (_, i) => `word${i}`).join(' ');
    const chunks = chunkText(text, { chunkSize: 300, chunkOverlap: 50 });
    // `>= 1` was the old assertion and no non-empty chunker can fail it. "Bounded" means a body
    // barely over the target does not explode into many pieces: 310 words at a 300-word target is
    // one split at most, so 2 is the ceiling, and every word must still be present exactly once
    // across the chunks (allowing for the 50-word overlap to repeat some).
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks.length).toBeLessThanOrEqual(2);
    for (const c of chunks) expect(c.text.trim().length).toBeGreaterThan(0);
    const joined = chunks.map((c) => c.text).join(' ');
    for (const w of ['word0', 'word155', 'word309']) expect(joined).toContain(w);
  });
});
