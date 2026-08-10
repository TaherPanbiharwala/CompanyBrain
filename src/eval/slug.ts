// Dataset id -> page slug. The single source of truth for the eval's join key.
//
// WHY ONE SHARED FUNCTION. This runs in two places: the LOADER (writing pages) and the SCORER
// (looking up which pages a question needed). If the two ever computed slugs differently — one
// truncating at 200, the other at 180 — every question would score zero, and the failure would look
// exactly like "retrieval is completely broken" rather than like a bug. One exported function makes
// that divergence unrepresentable; there is no second copy to drift.
//
// WHY A HASH SUFFIX AND NOT PLAIN TRUNCATION. The ingest op caps slugs at 200 characters
// (src/api/operations.ts). Measured on MultiHop-RAG: the longest URL-derived slug is 250 and three
// of 609 exceed the cap, so truncation is not hypothetical. But truncation ALONE reintroduces the
// problem it solves — two URLs sharing their first 200 characters collapse into one slug, and then
// two documents fight over one identity. Hashing the FULL id into the tail means ids that differ
// anywhere, at any position, still land on different slugs. That is a property of the construction,
// not of any particular corpus, which matters because "I verified uniqueness over these 609" expires
// the moment a second dataset arrives.
import { createHash } from 'node:crypto';

/** Pinned to the `ingest` op's own cap and charset by test/eval-harness.test.ts, which imports the
 *  authoritative values from src/api/operations.ts and asserts these agree. There is no way to share
 *  a constant with a zod literal without importing the op module (and its whole dependency chain)
 *  into this pure one, so the two copies are held together by a test or not at all — the same
 *  arrangement GRANT_TAG_RE uses for its two SQL copies. */
export const SLUG_MAX_LEN = 200;
export const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** 12 hex chars = 48 bits. Birthday-bounded collision probability is ~0.002% at 100k documents and
 *  ~0.2% at 1M — negligible at any corpus size an eval realistically loads, and it degrades
 *  gracefully rather than falling off a cliff. */
const HASH_LEN = 12;
/** Room for `<prefix>-<hash>` inside the cap. */
const PREFIX_LEN = SLUG_MAX_LEN - HASH_LEN - 1; // 187

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, HASH_LEN);
}

/**
 * Convert any dataset document id into a slug the `ingest` op will accept.
 *
 * Handles both shapes real benchmarks use: URLs (MultiHop-RAG) and opaque ids (BEIR's `MED-10`).
 * The scheme/`www.` strip is what keeps URL-derived slugs readable; it is a no-op on an opaque id.
 */
export function slugify(id: string): string {
  const normalized = id
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') // strip scheme; no-op on non-URLs
    .replace(/^www\./i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // Nothing survived normalization (an id of pure punctuation, or empty). The hash is hex, so it
  // satisfies the leading-[a-z0-9] rule that a bare `-` prefix would violate.
  if (normalized.length === 0) return shortHash(id);
  if (normalized.length <= SLUG_MAX_LEN) return normalized;

  // Trailing `-` is trimmed so the join does not produce `--`; the result is then <= 200 either way.
  const prefix = normalized.slice(0, PREFIX_LEN).replace(/-+$/, '');
  const suffix = shortHash(id);
  return prefix.length === 0 ? suffix : `${prefix}-${suffix}`;
}

/**
 * Corpus-level guard for the one collision `slugify` cannot see on its own.
 *
 * The hash suffix closes truncation collisions structurally, but `slugify` is a PURE PER-ID
 * function: it cannot know that some other document normalizes to the same string. Two distinct ids
 * that are already under the cap and differ only in characters normalization folds away (`MED-10`
 * vs `med_10`) still collide, and no per-id rule can prevent that. So the loader calls this over the
 * whole corpus BEFORE the first paid embedding, and fails loudly with both offending ids rather than
 * silently zeroing every question that touches them.
 */
export function findSlugCollisions(ids: readonly string[]): Map<string, string[]> {
  const bySlug = new Map<string, string[]>();
  for (const id of ids) {
    const slug = slugify(id);
    const existing = bySlug.get(slug);
    if (existing) existing.push(id);
    else bySlug.set(slug, [id]);
  }
  for (const [slug, members] of bySlug) {
    if (members.length < 2) bySlug.delete(slug);
  }
  return bySlug;
}
