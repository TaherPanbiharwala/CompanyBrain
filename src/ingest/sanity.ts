// The junk gate. Pure — no database, no network — so it is trivially testable and can run anywhere.
//
// Position in the pipeline is the point: AFTER extraction, BEFORE embedding. Every rejection here is
// money not spent on a document that was never going to be retrievable, and a typed error instead of
// a page full of noise sitting in the index forever.
//
// Deliberately conservative. A false reject is a user telling you the gate is wrong, which is
// recoverable. A false accept is silent index pollution that nobody notices until answers get worse.
// So every threshold here is set where the content is unambiguously not prose.
import { createHash } from 'node:crypto';
import type { Extracted } from './blocks.ts';
import { isDegraded } from './blocks.ts';

export type SanityVerdict =
  | { ok: true; degraded: boolean; reason?: undefined }
  | { ok: false; reason: SanityReason; detail: string };

export type SanityReason =
  | 'empty' // nothing came out
  | 'too_short' // came out, but there is nothing to retrieve
  | 'binary' // high non-printable ratio — not text in any useful sense
  | 'no_word_boundaries'; // one enormous token: minified JS, base64, a hex dump

/** Below this there is no retrievable content. A page title alone is not a document. */
const MIN_TOTAL_CHARS = 40;
/** Control/replacement characters as a share of the text. Real prose is ~0. */
const MAX_NONPRINTABLE_RATIO = 0.1;
/** Longest run with no whitespace. Real language, in any script, breaks well before this. */
const MAX_TOKEN_CHARS = 2_000;

export function assessExtraction(e: Extracted): SanityVerdict {
  if (e.blocks.length === 0) {
    return { ok: false, reason: 'empty', detail: 'extraction produced no content' };
  }

  const text = e.blocks.map((b) => b.text).join('\n');
  const trimmed = text.trim();

  if (trimmed.length < MIN_TOTAL_CHARS) {
    return {
      ok: false,
      reason: 'too_short',
      detail: `only ${trimmed.length} characters of text (minimum ${MIN_TOTAL_CHARS})`,
    };
  }

  // Count on CODE POINTS, not UTF-16 units: Devanagari, Tamil and emoji are multi-unit, and a
  // byte-or-unit-based ratio would classify a perfectly good Hindi document as binary. This product
  // is India-first; getting that backwards would reject the target market's documents.
  let nonPrintable = 0;
  let total = 0;
  for (const ch of trimmed) {
    total++;
    const cp = ch.codePointAt(0)!;
    if (cp === 0xfffd || (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || (cp >= 0x7f && cp <= 0x9f)) {
      nonPrintable++;
    }
  }
  if (total > 0 && nonPrintable / total > MAX_NONPRINTABLE_RATIO) {
    return {
      ok: false,
      reason: 'binary',
      detail: `${Math.round((nonPrintable / total) * 100)}% of characters are not printable text`,
    };
  }

  const longestToken = trimmed.split(/\s+/).reduce((m, t) => Math.max(m, t.length), 0);
  if (longestToken > MAX_TOKEN_CHARS) {
    return {
      ok: false,
      reason: 'no_word_boundaries',
      detail: `contains a ${longestToken}-character run with no spaces — looks like encoded data rather than a document`,
    };
  }

  // Passed, but possibly incomplete. `degraded` is NOT a rejection: the content that did extract is
  // worth keeping. It is a signal the caller must pass through to the user, because a 40-page PDF
  // where 37 pages were scans looks exactly like a clean 3-page ingest from the outside.
  return { ok: true, degraded: isDegraded(e) };
}

/** Content hash of the ORIGINAL bytes, for duplicate detection at the door.
 *  Cheaper and more reliable than similarity search after the fact: the same file uploaded twice is
 *  the most common real user action, and catching it here avoids paying to embed it again. */
export function contentHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Human-facing remediation per reason. The gate exists to stop junk, but a user whose real document
 *  was rejected needs to know which of their problems this is. */
export function sanitySuggestion(reason: SanityReason): string {
  switch (reason) {
    case 'empty':
      return 'Nothing could be read from this file. If it is a scanned PDF, the text layer is missing — OCR is not supported yet.';
    case 'too_short':
      return 'Add more content, or paste the text directly instead of uploading a file.';
    case 'binary':
      return 'This looks like a binary file rather than a document. Check you uploaded the right file.';
    case 'no_word_boundaries':
      return 'This looks like encoded or minified data rather than prose. Upload the source document instead.';
  }
}
