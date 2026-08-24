// Recursive delimiter-aware text chunker. Ported from gbrain's
// src/core/chunkers/recursive.ts under MIT — see NOTICE. Adapted for the A17 spike: no CJK-aware
// word counting (English-only corpus for this milestone) and no takes/facts-fence stripping (no
// equivalent data model in company-brain yet) — everything else (the 5-level delimiter hierarchy,
// greedy merge, sentence-aware overlap, hard char cap) is faithful to the source algorithm.
//
// TWO ENTRY POINTS, deliberately not one:
//   * chunkText(text)     — pasted text. Word-based, unchanged, still the gbrain algorithm.
//   * chunkBlocks(blocks) — extracted files. Packs structure, so a spreadsheet row keeps its header
//                           and a PDF chunk knows its page.
//
// An earlier design made chunkText a thin wrapper over chunkBlocks. That was wrong twice: a single
// paragraph with no blank lines becomes ONE block, so "overlap at block boundaries" silently produced
// no overlap at all, and a heading-path prefix breaks the losslessness property
// (`text.indexOf(chunk.text) >= 0`) that test/chunk.test.ts asserts. Pasted prose and extracted
// structure are different problems; sharing one code path made both worse.
export interface ChunkOptions {
  chunkSize?: number; // target words per chunk (default 300)
  chunkOverlap?: number; // overlap words (default 50)
  maxChars?: number; // hard cap on any chunk's char length (default 6000)
}

/** Stamped onto every chunk row at write time (migration 0014). No existing versioning scheme in
 *  this file to match — bump by hand when the chunking algorithm changes materially enough that a
 *  targeted re-chunk (rather than a blind full-corpus rebuild) would be worth triggering on it later.
 *  No consumer reads this yet. */
export const CHUNKER_VERSION = 'v1';

export interface TextChunk {
  text: string;
  index: number;
}

// L0 paragraphs -> L1 lines -> L2 sentences -> L3 clauses -> L4 words (whitespace fallback).
const DELIMITERS: string[][] = [
  ['\n\n'],
  ['\n'],
  ['. ', '! ', '? ', '.\n', '!\n', '?\n'],
  ['; ', ': ', ', '],
  [],
];

function countWords(text: string): number {
  return (text.match(/\S+/g) || []).length;
}

export function chunkText(text: string, opts?: ChunkOptions): TextChunk[] {
  // ?? not || — an explicit 0 (e.g. chunkOverlap: 0, "no overlap") must be honored, not silently
  // replaced by the default (a footgun in the gbrain source this was ported from: 0 is falsy).
  const chunkSize = opts?.chunkSize ?? 300;
  const chunkOverlap = opts?.chunkOverlap ?? 50;
  const maxChars = opts?.maxChars ?? 6000;

  if (!text || text.trim().length === 0) return [];

  const wordCount = countWords(text);
  if (wordCount <= chunkSize) {
    const capped = capByChars(text.trim(), maxChars);
    return capped.map((t, i) => ({ text: t, index: i }));
  }

  const pieces = recursiveSplit(text, 0, chunkSize);
  const merged = greedyMerge(pieces, chunkSize);
  const withOverlap = applyOverlap(merged, chunkOverlap);
  const capped: string[] = [];
  for (const chunk of withOverlap) {
    capped.push(...capByChars(chunk.trim(), maxChars));
  }
  return capped.map((t, i) => ({ text: t, index: i }));
}

/** Hard-cap a chunk's char length via a sliding window (safety net for pathological input the
 *  word-level pipeline can't bound, e.g. a long URL or base64 blob with no whitespace). */
function capByChars(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return text.length > 0 ? [text] : [];
  const overlap = Math.min(500, Math.floor(maxChars / 10));
  const stride = Math.max(1, maxChars - overlap);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += stride) {
    const slice = text.slice(i, i + maxChars).trim();
    if (slice.length > 0) out.push(slice);
    if (i + maxChars >= text.length) break;
  }
  return out;
}

function recursiveSplit(text: string, level: number, target: number): string[] {
  if (level >= DELIMITERS.length) return splitOnWhitespace(text, target);

  const delimiters = DELIMITERS[level];
  if (!delimiters || delimiters.length === 0) return splitOnWhitespace(text, target);

  const pieces = splitAtDelimiters(text, delimiters);
  if (pieces.length <= 1) return recursiveSplit(text, level + 1, target);

  const result: string[] = [];
  for (const piece of pieces) {
    if (countWords(piece) > target) {
      result.push(...recursiveSplit(piece, level + 1, target));
    } else {
      result.push(piece);
    }
  }
  return result;
}

/** Split at delimiter boundaries, keeping the delimiter with the preceding piece (lossless).
 *
 *  LINEAR, not quadratic. This used to `indexOf` every delimiter over the whole REMAINING string on
 *  every iteration, then re-slice `remaining` — so a delimiter that never occurs (`'! '` and `'? '`
 *  in ordinary prose are the common case) cost a full scan per piece. That was tolerable when the
 *  only input was a pasted note; the file path feeds it whole extracted documents, and a plain-text
 *  upload with no blank lines arrives as ONE block, which chunkBlocks then routes straight here. On
 *  a single-threaded runtime that blocks the entire API process, not just the request.
 *
 *  Now each delimiter's next occurrence is found once and re-scanned only after it is consumed, and
 *  positions are absolute offsets so nothing is re-sliced while scanning. */
function splitAtDelimiters(text: string, delimiters: string[]): string[] {
  const pieces: string[] = [];
  // next[i] = absolute index of delimiters[i] at or after `cursor`, or -1 once exhausted.
  const next = delimiters.map((d) => text.indexOf(d));
  let cursor = 0;

  while (cursor < text.length) {
    let earliest = -1;
    let earliestDelim = '';
    for (let i = 0; i < delimiters.length; i++) {
      // Only re-scan a delimiter whose cached hit has been passed, so the total work per delimiter
      // is one forward pass over the text rather than one pass per piece.
      if (next[i]! !== -1 && next[i]! < cursor) next[i] = text.indexOf(delimiters[i]!, cursor);
      const idx = next[i]!;
      if (idx !== -1 && (earliest === -1 || idx < earliest)) {
        earliest = idx;
        earliestDelim = delimiters[i]!;
      }
    }
    if (earliest === -1) {
      const tail = text.slice(cursor);
      if (tail.trim().length > 0) pieces.push(tail);
      break;
    }
    const end = earliest + earliestDelim.length;
    const piece = text.slice(cursor, end);
    if (piece.trim().length > 0) pieces.push(piece);
    cursor = end;
  }
  return pieces;
}

/** Fallback: split on whitespace, or (no whitespace / one giant token) slice by char, so the
 *  chunker always makes forward progress and stays bounded even on pathological input. */
function splitOnWhitespace(text: string, target: number): string[] {
  const words = text.match(/\S+\s*/g) || [];
  const first = words[0];
  const noUsefulWhitespace = words.length === 0 || (words.length === 1 && !!first && first.length > target);
  if (noUsefulWhitespace) {
    if (text.trim().length === 0) return [];
    const pieces: string[] = [];
    const charsPerPiece = Math.max(1, target);
    for (let i = 0; i < text.length; i += charsPerPiece) {
      const slice = text.slice(i, i + charsPerPiece);
      if (slice.trim().length > 0) pieces.push(slice);
    }
    return pieces;
  }

  const pieces: string[] = [];
  for (let i = 0; i < words.length; i += target) {
    const slice = words.slice(i, i + target).join('');
    if (slice.trim().length > 0) pieces.push(slice);
  }
  return pieces;
}

/** Greedily merge adjacent pieces toward the target size, never exceeding target*1.5. */
function greedyMerge(pieces: string[], target: number): string[] {
  if (pieces.length === 0) return [];

  const result: string[] = [];
  let current = pieces[0] as string;

  for (let i = 1; i < pieces.length; i++) {
    const combined = current + pieces[i];
    if (countWords(combined) <= Math.ceil(target * 1.5)) {
      current = combined;
    } else {
      result.push(current);
      current = pieces[i] as string;
    }
  }
  if (current.trim().length > 0) result.push(current);
  return result;
}

/** Sentence-aware trailing overlap: the last N words of chunk[i] are prepended to chunk[i+1]. */
function applyOverlap(chunks: string[], overlapWords: number): string[] {
  if (chunks.length <= 1 || overlapWords <= 0) return chunks;

  const result: string[] = [chunks[0] as string];
  for (let i = 1; i < chunks.length; i++) {
    const prevTrailing = extractTrailingContext(chunks[i - 1] as string, overlapWords);
    result.push(prevTrailing + (chunks[i] as string));
  }
  return result;
}

/** Last N words of `text`, nudged to start at a sentence boundary when one falls within them. */
function extractTrailingContext(text: string, targetWords: number): string {
  const words = text.match(/\S+\s*/g) || [];
  if (words.length <= targetWords) return '';

  const trailing = words.slice(-targetWords).join('');
  const sentenceStart = trailing.search(/[.!?]\s+/);
  if (sentenceStart !== -1 && sentenceStart < trailing.length / 2) {
    const afterSentence = trailing.slice(sentenceStart).replace(/^[.!?]\s+/, '');
    if (afterSentence.trim().length > 0) return afterSentence;
  }
  return trailing;
}

// ── Block-based chunking (files) ──────────────────────────────────────────

import type { Block, Locator } from './blocks.ts';
import { mergeLocators } from './blocks.ts';

export interface BlockChunk {
  text: string;
  index: number;
  locator?: Locator;
}

export interface BlockChunkOptions {
  /** Target tokens per chunk. The architecture asks for 400-800; 600 sits in the middle. */
  targetTokens?: number;
  /** Overlap as a fraction of the target. 10-15% per the architecture. */
  overlapRatio?: number;
  /** Absolute ceiling. Derived from the target rather than a magic 6000, so the two cannot drift. */
  maxTokens?: number;
}

/** Token estimate over UTF-8 BYTES, not characters.
 *
 *  `Math.ceil(text.length / 4)` — the estimate used elsewhere in this repo for `token_count` — is
 *  roughly right for ASCII and roughly 4x WRONG for Devanagari and Tamil, where one character is
 *  three UTF-8 bytes. Since BPE tokenizers operate on bytes, bytes/4 self-corrects across scripts.
 *  Getting this backwards in an India-first product means Hindi chunks come out ~4x the intended
 *  size and blow past the embedding model's 8192-token input limit — a hard 400 at the very end of
 *  the pipeline, on exactly the corpus the product is for. */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

/** `## Pricing > Growth tier` — the heading path a chunk sits under, prefixed onto its text so a
 *  retrieved fragment carries the context a human would need to make sense of it. */
function headingPrefix(path: string[]): string {
  return path.length > 0 ? `${path.join(' > ')}\n\n` : '';
}

/** Slice `s` into runs of at most `maxBytes` UTF-8 bytes, never splitting a code point.
 *
 *  Bytes, not characters, and that is the whole trick: `estimateTokens` is `ceil(utf8Bytes / 4)`, so
 *  a byte bound IS a token bound. Everything below can therefore guarantee its output fits WITHOUT
 *  looping over an estimate that might not shrink. */
function sliceByBytes(s: string, maxBytes: number): string[] {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const cp of s) {
    // Iterating the string yields code points, so a 4-byte emoji or Devanagari cluster is never cut.
    const n = Buffer.byteLength(cp, 'utf8');
    if (bytes + n > maxBytes && cur) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += cp;
    bytes += n;
  }
  if (cur) out.push(cur);
  return out;
}

/** Break `body` into pieces of at most `budget` tokens — at line boundaries where one fits, by bytes
 *  when a single line does not. A `row` block is one line, so rows stay whole wherever possible,
 *  preserving rule 1 below; the byte path is the escape hatch for a row wider than the whole cap. */
function splitToBudget(body: string, budget: number): string[] {
  if (estimateTokens(body) <= budget) return [body];
  const maxBytes = budget * 4;
  const out: string[] = [];
  let cur = '';
  for (const line of body.split('\n')) {
    const cand = cur ? `${cur}\n${line}` : line;
    if (Buffer.byteLength(cand, 'utf8') <= maxBytes) {
      cur = cand;
      continue;
    }
    if (cur) {
      out.push(cur);
      cur = '';
    }
    if (Buffer.byteLength(line, 'utf8') <= maxBytes) {
      cur = line;
      continue;
    }
    out.push(...sliceByBytes(line, maxBytes));
  }
  if (cur) out.push(cur);
  return out;
}

/** Fraction of the cap the heading path + table header may occupy. */
const FRAME_SHARE = 0.5;

/** Bound the non-body part of a chunk — heading path plus repeated table header.
 *
 *  `prefix` is as unbounded as `header`: it is `headingPath.join(' > ')`, and nothing caps a
 *  heading's length or the nesting depth, both of which come from the document. Capping only the
 *  header would leave the non-convergent case intact — if the prefix alone exceeded the budget there
 *  would be no room for any body at all. Bounding the frame FIRST is what makes the body budget
 *  positive by construction rather than by hope. */
function capFrame(prefix: string, header: string, maxTokens: number): string {
  const frameCap = Math.max(1, Math.floor(maxTokens * FRAME_SHARE));
  const prefixCap = Math.max(1, Math.floor(frameCap / 2));

  let p = prefix;
  if (estimateTokens(p) > prefixCap) p = `${sliceByBytes(p, prefixCap * 4)[0]!}…\n\n`;

  let h = header;
  const headerCap = Math.max(1, frameCap - estimateTokens(p));
  if (h && estimateTokens(h) > headerCap) {
    const kept = sliceByBytes(h, headerCap * 4)[0]!;
    // Column count, not byte count: "+7 more columns" is actionable, "+312 bytes" is not.
    const dropped = h.slice(kept.length).split(' | ').length;
    h = `${kept}… (+${dropped} more columns)`;
  }

  const frame = `${p}${h ? `${h}\n` : ''}`;
  // The floor. Both branches above append a marker after slicing, so either can overshoot its own
  // cap by the marker's length; this is what actually enforces the bound the caller relies on.
  return estimateTokens(frame) > frameCap ? sliceByBytes(frame, frameCap * 4)[0]! : frame;
}

/**
 * Pack blocks into chunks.
 *
 * Rules, in priority order:
 *   1. A `row` or `table` block is never split mid-row — a half-row is unretrievable — UNLESS it
 *      exceeds the hard cap alone, in which case the cap wins and the row is split with its header
 *      repeated. A 50-column row can exceed both the target and the embedding input limit, so
 *      "never split" cannot be absolute or ingest hard-fails at the very last step.
 *   2. A heading stays with what follows it.
 *   3. Every chunk carries its heading path, and every chunk containing rows carries the header once.
 *   4. Overlap applies between prose chunks only. Repeating rows would duplicate records into the
 *      index, which is the flooding problem dedup exists to solve — introducing it here would be
 *      self-defeating.
 */
export function chunkBlocks(blocks: Block[], opts?: BlockChunkOptions): BlockChunk[] {
  const target = opts?.targetTokens ?? 600;
  const overlapRatio = opts?.overlapRatio ?? 0.12;
  const maxTokens = opts?.maxTokens ?? Math.ceil(target * 1.5);
  const overlapTokens = Math.round(target * overlapRatio);

  const out: BlockChunk[] = [];
  const headingPath: { level: number; text: string }[] = [];

  let buf: Block[] = [];
  let bufTokens = 0;
  let lastHeader: string | undefined;

  /**
   * THE emitter. Every chunk leaves through here, and it measures what it EMITS.
   *
   * The defect this closes: the packing budget was kept on `block.text` alone, while the string that
   * actually reached `embedAll` was `prefix + header + body`. Neither the heading path nor the
   * repeated table header was ever counted, so `maxTokens` — documented as an absolute ceiling —
   * bounded nothing that was emitted. A 5,000-column CSV produced 44 chunks of ~17,600 tokens each
   * against a 7,500 limit, and every one of them was an untyped 500 at the last step of ingest.
   *
   * There were also TWO push sites, and the escape hatch below did not go through `flush()` — so a
   * fix applied only to `flush()` would have skipped the more dangerous of the two. One emitter, or
   * the guarantee is worthless.
   */
  const emit = (header: string | undefined, body: string, locator: Locator | undefined): void => {
    const frame = capFrame(headingPrefix(headingPath.map((h) => h.text)), header ?? '', maxTokens);
    // >= 1 by construction: capFrame's floor bounds the frame to at most half the cap, and Math.max
    // covers the degenerate maxTokens=1 case. A positive budget is what makes this terminate.
    const budget = Math.max(1, maxTokens - estimateTokens(frame));
    for (const piece of splitToBudget(body, budget)) {
      const text = `${frame}${piece}`.trim();
      if (text) out.push({ text, index: out.length, locator });
    }
  };

  const flush = (): void => {
    if (buf.length === 0) return;
    // The header rides ONCE per chunk, not once per row — a 50-column header inlined per row would
    // be most of the payload and would make every row's embedding near-identical.
    emit(
      buf.find((b) => b.header)?.header,
      buf.map((b) => b.text).join('\n'),
      mergeLocators(buf.map((b) => b.locator)),
    );
    buf = [];
    bufTokens = 0;
  };

  for (const block of blocks) {
    if (block.kind === 'heading') {
      // A heading starts a new chunk rather than trailing the previous one, so it is never orphaned
      // from the content it introduces.
      flush();
      const level = block.level ?? 1;
      while (headingPath.length > 0 && headingPath[headingPath.length - 1]!.level >= level) headingPath.pop();
      headingPath.push({ level, text: block.text });
      continue;
    }

    const blockTokens = estimateTokens(block.text);

    // Rule 1's escape hatch: one block that alone exceeds the hard cap. Split it with the recursive
    // splitter and let each piece keep the header and locator.
    if (blockTokens > maxTokens) {
      flush();
      // chunkText first for SEMANTIC boundaries (it splits on paragraph/sentence delimiters), then
      // emit for the HARD bound. Its chunkSize is a WORD count while the cap is in tokens and its
      // own fallback is in characters — three units, none of which the provider enforces. So its
      // output is a suggestion; emit is what guarantees the result fits.
      const approxWords = Math.max(50, Math.round(target * 0.75));
      for (const piece of chunkText(block.text, { chunkSize: approxWords, chunkOverlap: 0 })) {
        emit(block.header, piece.text, block.locator);
      }
      lastHeader = block.header;
      continue;
    }

    // A change of header means a different sheet or table: never mix two headers in one chunk, or
    // the rows under the second one are labelled with the first one's columns.
    if (block.header && lastHeader && block.header !== lastHeader) flush();
    if (block.header) lastHeader = block.header;

    if (bufTokens + blockTokens > target && buf.length > 0) {
      const carry = overlapTokens > 0 && block.kind !== 'row' ? tailForOverlap(buf, overlapTokens) : [];
      flush();
      buf = [...carry];
      bufTokens = carry.reduce((n, b) => n + estimateTokens(b.text), 0);
    }

    buf.push(block);
    bufTokens += blockTokens;
  }

  flush();
  return out.map((c, i) => ({ ...c, index: i }));
}

/** The trailing blocks worth repeating into the next chunk, newest first, up to a token budget.
 *  Whole blocks only — a half-sentence of overlap helps nothing, and splitting here would undo the
 *  structure the extractor worked to produce. */
function tailForOverlap(buf: Block[], budget: number): Block[] {
  const carry: Block[] = [];
  let used = 0;
  for (let i = buf.length - 1; i >= 0; i--) {
    const b = buf[i]!;
    const t = estimateTokens(b.text);
    if (used + t > budget) break;
    carry.unshift(b);
    used += t;
  }
  return carry;
}
