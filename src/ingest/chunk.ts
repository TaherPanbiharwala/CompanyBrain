// Recursive delimiter-aware text chunker. Ported from gbrain's
// src/core/chunkers/recursive.ts under MIT — see NOTICE. Adapted for the A17 spike: no CJK-aware
// word counting (English-only corpus for this milestone) and no takes/facts-fence stripping (no
// equivalent data model in company-brain yet) — everything else (the 5-level delimiter hierarchy,
// greedy merge, sentence-aware overlap, hard char cap) is faithful to the source algorithm.
export interface ChunkOptions {
  chunkSize?: number; // target words per chunk (default 300)
  chunkOverlap?: number; // overlap words (default 50)
  maxChars?: number; // hard cap on any chunk's char length (default 6000)
}

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

/** Split at delimiter boundaries, keeping the delimiter with the preceding piece (lossless). */
function splitAtDelimiters(text: string, delimiters: string[]): string[] {
  const pieces: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    let earliest = -1;
    let earliestDelim = '';
    for (const delim of delimiters) {
      const idx = remaining.indexOf(delim);
      if (idx !== -1 && (earliest === -1 || idx < earliest)) {
        earliest = idx;
        earliestDelim = delim;
      }
    }
    if (earliest === -1) {
      pieces.push(remaining);
      break;
    }
    const piece = remaining.slice(0, earliest + earliestDelim.length);
    if (piece.trim().length > 0) pieces.push(piece);
    remaining = remaining.slice(earliest + earliestDelim.length);
  }
  return pieces.filter((p) => p.trim().length > 0);
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
