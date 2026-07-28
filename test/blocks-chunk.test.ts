// Block-based chunking: the properties that make extracted structure retrievable.
//
// No database, no network. Each case corresponds to a way naive chunking silently destroys a
// document — a half row, a heading orphaned from its body, a token estimate that is right for
// English and 4x wrong for Hindi.
import { describe, it, expect } from 'bun:test';
import { chunkBlocks, chunkText, estimateTokens } from '../src/ingest/chunk.ts';
import type { Block } from '../src/ingest/blocks.ts';
import { assessExtraction, contentHash } from '../src/ingest/sanity.ts';

const para = (text: string): Block => ({ text, kind: 'paragraph' });
const row = (text: string, header: string, sheet: string, cell: string): Block => ({
  text,
  kind: 'row',
  header,
  locator: { kind: 'sheet', sheet, from: cell, to: cell },
});

describe('estimateTokens — bytes, not characters', () => {
  it('is roughly chars/4 for ASCII', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });

  it('does not under-count Devanagari by 4x', () => {
    // One Devanagari character is three UTF-8 bytes. A chars/4 estimate says 25 tokens for this
    // string; the byte-based one says ~75. Under-counting means chunks come out ~4x the intended
    // size and blow past the embedding model's 8192-token input — a hard failure at the very end of
    // the pipeline, on exactly the corpus an India-first product exists to serve.
    const hindi = 'न'.repeat(100);
    expect(estimateTokens(hindi)).toBeGreaterThan(estimateTokens('n'.repeat(100)) * 2);
  });
});

describe('chunkBlocks — structure survives', () => {
  it('a heading is carried onto the chunks beneath it', () => {
    const chunks = chunkBlocks([
      { text: 'Pricing', kind: 'heading', level: 1 },
      { text: 'Growth tier', kind: 'heading', level: 2 },
      para('The per-robot fee is 3900 with a volume discount.'),
    ]);
    expect(chunks).toHaveLength(1);
    // Without this a retrieved fragment reads "The per-robot fee is 3900" with no indication of
    // WHICH tier — the exact context a human needs to trust the answer.
    expect(chunks[0]!.text).toContain('Pricing > Growth tier');
    expect(chunks[0]!.text).toContain('3900');
  });

  it('a deeper heading replaces its sibling, not its parent', () => {
    const chunks = chunkBlocks([
      { text: 'Pricing', kind: 'heading', level: 1 },
      { text: 'Starter', kind: 'heading', level: 2 },
      para('a'.repeat(4000)),
      { text: 'Growth', kind: 'heading', level: 2 },
      para('b'.repeat(4000)),
    ]);
    const second = chunks.find((c) => c.text.includes('bbbb'))!;
    expect(second.text).toContain('Pricing > Growth');
    expect(second.text).not.toContain('Starter');
  });

  it('a row keeps its header, and the header appears ONCE per chunk', () => {
    const hdr = 'Item | Qty | Rate';
    const chunks = chunkBlocks(
      Array.from({ length: 20 }, (_, i) => row(`Item ${i} | ${i} | ${i * 100}`, hdr, 'Sheet1', `A${i + 2}`)),
      { targetTokens: 60 },
    );
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      // Once, not once per row: a 50-column header inlined per row would be most of the payload and
      // would make every row's embedding near-identical.
      expect(c.text.split(hdr).length - 1, 'header must appear exactly once per chunk').toBe(1);
    }
  });

  it('never splits a row across chunks', () => {
    const hdr = 'A | B';
    const chunks = chunkBlocks(
      Array.from({ length: 12 }, (_, i) => row(`value-${i} | other-${i}`, hdr, 'S', `A${i + 2}`)),
      { targetTokens: 30 },
    );
    // Every emitted row must appear whole somewhere. A half-row is unretrievable.
    for (let i = 0; i < 12; i++) {
      expect(chunks.some((c) => c.text.includes(`value-${i} | other-${i}`)), `row ${i} was split`).toBe(true);
    }
  });

  it('does not mix two different headers into one chunk', () => {
    // Rows under a second sheet's header would otherwise be labelled with the first sheet's columns —
    // silently wrong data, not a formatting nit.
    const chunks = chunkBlocks(
      [
        row('a | 1', 'X | Y', 'S1', 'A2'),
        row('b | 2', 'X | Y', 'S1', 'A3'),
        row('c | 3', 'P | Q', 'S2', 'A2'),
      ],
      { targetTokens: 500 },
    );
    for (const c of chunks) {
      const hasX = c.text.includes('X | Y');
      const hasP = c.text.includes('P | Q');
      expect(hasX && hasP, 'two headers in one chunk').toBe(false);
    }
  });

  it('merges page locators into a span across the blocks it packed', () => {
    const chunks = chunkBlocks(
      [
        { text: 'end of page seven', kind: 'paragraph', locator: { kind: 'page', from: 7, to: 7 } },
        { text: 'start of page eight', kind: 'paragraph', locator: { kind: 'page', from: 8, to: 8 } },
      ],
      { targetTokens: 500 },
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.locator).toEqual({ kind: 'page', from: 7, to: 8 });
  });

  it('splits a single oversized block rather than emitting one unusable chunk', () => {
    // The hard cap has to win over "never split a row": a 50-column row can exceed the embedding
    // model's input limit on its own, and refusing to split would hard-fail the whole ingest.
    const huge = row('x '.repeat(6000), 'H1 | H2', 'S', 'A2');
    const chunks = chunkBlocks([huge], { targetTokens: 200 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text).toContain('H1 | H2'); // header survives every piece
  });

  it('applies overlap between prose chunks but NOT between rows', () => {
    const prose = Array.from({ length: 12 }, (_, i) => para(`Paragraph number ${i} with some filler text in it.`));
    const proseChunks = chunkBlocks(prose, { targetTokens: 40, overlapRatio: 0.3 });
    const proseLen = proseChunks.reduce((n, c) => n + c.text.length, 0);
    const noOverlap = chunkBlocks(prose, { targetTokens: 40, overlapRatio: 0 });
    expect(proseLen).toBeGreaterThan(noOverlap.reduce((n, c) => n + c.text.length, 0));

    // Rows must NOT overlap: duplicating records into the index is the flooding problem dedup exists
    // to solve, so introducing it in the chunker would be self-defeating.
    const rows = Array.from({ length: 12 }, (_, i) => row(`r${i} | v${i}`, 'A | B', 'S', `A${i + 2}`));
    const withOv = chunkBlocks(rows, { targetTokens: 30, overlapRatio: 0.3 });
    for (let i = 0; i < 12; i++) {
      const hits = withOv.filter((c) => c.text.includes(`r${i} | v${i}`)).length;
      expect(hits, `row ${i} appears in ${hits} chunks`).toBe(1);
    }
  });

  it('empty input yields no chunks', () => {
    expect(chunkBlocks([])).toEqual([]);
  });
});

describe('chunkText is untouched by the block work', () => {
  it('still splits pasted prose the old way', () => {
    // The two entry points are separate on purpose. Making chunkText a wrapper over chunkBlocks
    // silently removed overlap for single-paragraph input and broke losslessness.
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(120);
    const chunks = chunkText(text, { chunkSize: 100, chunkOverlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });
});

describe('sanity gate', () => {
  const ok = (blocks: Block[]) => ({
    format: 'text' as const,
    blocks,
    meta: {},
    unitsExtracted: 1,
    unitsSkipped: 0,
  });

  it('accepts ordinary prose', () => {
    const v = assessExtraction(ok([para('Finch asked for a twelve percent discount on the per-robot fee.')]));
    expect(v.ok).toBe(true);
  });

  it('rejects an empty extraction', () => {
    const v = assessExtraction(ok([]));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('empty');
  });

  it('rejects a document with nothing to retrieve', () => {
    const v = assessExtraction(ok([para('too short')]));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('too_short');
  });

  it('rejects binary noise', () => {
    const v = assessExtraction(ok([para(''.repeat(40))]));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('binary');
  });

  it('ACCEPTS Devanagari — it is text, not binary', () => {
    // The non-printable ratio counts code points, not UTF-16 units. Counting units would classify a
    // perfectly good Hindi document as binary and reject the target market's documents.
    const v = assessExtraction(ok([para('नॉर्थस्टार रोबोटिक्स की तिमाही आय ४.२ करोड़ रुपये थी। '.repeat(3))]));
    expect(v.ok).toBe(true);
  });

  it('rejects a single enormous token', () => {
    const v = assessExtraction(ok([para('A'.repeat(3000))]));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('no_word_boundaries');
  });

  it('flags a mostly-scanned PDF as degraded rather than rejecting it', () => {
    const v = assessExtraction({
      format: 'pdf',
      blocks: [para('one page of real text that is long enough to pass the floor')],
      meta: {},
      unitsExtracted: 3,
      unitsSkipped: 37,
    });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.degraded, '37 of 40 pages had no text layer').toBe(true);
  });

  it('content hash is stable and content-addressed', () => {
    const a = contentHash(new TextEncoder().encode('same bytes'));
    expect(a).toBe(contentHash(new TextEncoder().encode('same bytes')));
    expect(a).not.toBe(contentHash(new TextEncoder().encode('other bytes')));
  });
});
