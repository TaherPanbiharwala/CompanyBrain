// Document provenance (migration 0014): effective_date and content_hash. Pure — no database, no
// network — and factored out here because both ingest paths (src/ingest/file.ts, src/ingest/import.ts)
// need the identical derivation, and replacePage (src/ingest/lifecycle.ts) needs the hash half again.
// An adversarial review of the M6 PR found the three copies had drifted apart into three separately
// inlined implementations with no single source of truth — this file closes that.
import { contentHash } from './sanity.ts';

export type EffectiveDateSource = 'manual' | 'upload_time';

export interface EffectiveDate {
  effectiveDate: string;
  effectiveDateSource: EffectiveDateSource;
}

/** Provenance sentinel: 'manual' when the caller supplied a date, else defaulted to today so a
 *  since/until search filter has something real to match against — leaving this NULL by default
 *  would make date filtering vacuous for every ordinarily-ingested page. */
export function deriveEffectiveDate(explicit?: string): EffectiveDate {
  return {
    effectiveDate: explicit ?? new Date().toISOString().slice(0, 10),
    effectiveDateSource: explicit ? 'manual' : 'upload_time',
  };
}

/** SHA-256 of TEXT — distinct from `contentHash()`'s own docstring purpose (hashing the ORIGINAL
 *  UPLOADED BYTES for `source_sha256`'s pre-embed upload dedup, file-ingest path only). This is
 *  `content_hash` (migration 0014): a change-detection hash over the EXTRACTED/BODY TEXT, the same
 *  on both ingest paths and on replace. Reuses `contentHash()` on the byte-generic `Uint8Array` it
 *  already accepts, so "the same text hashes the same way" cannot drift between call sites the way
 *  three separate inline `contentHash(Buffer.from(text, 'utf8'))` calls could. */
export function textHash(text: string): string {
  return contentHash(Buffer.from(text, 'utf8'));
}
