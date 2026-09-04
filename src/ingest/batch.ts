// Batch file ingest: orchestrate N independent importFile() calls and aggregate their outcomes.
//
// Unlike lifecycle.ts's deletePages/rescopePages, this is NOT one shared transaction over many rows
// — importFile() calls embedAll() OUTSIDE any transaction (D6) and then opens its OWN withScopedTx
// per file (page + page_sources + content_chunks, one multi-row insert that must never combine chunks
// from two different files — see MAX_CHUNKS_PER_INSERT in file.ts). A batch of N files is therefore N
// already-atomic units of work; this module's whole job is orchestration and outcome aggregation, not
// transaction plumbing.
//
// PARTITION, NOT ABORT — same convention lifecycle.ts's batch ops already established for
// deletePages/rescopePages. One bad file (wrong format, oversized, a duplicate) must never cost the
// rest of the batch its extraction+embedding spend.
import type { OperationContext } from '../core/context.ts';
import type { PageScope } from '../core/context.ts';
import type { PackKind } from '../core/pack.ts';
import { OperationError, type OpErrorCode } from '../api/errors.ts';
import { importFile } from './file.ts';
import { contentHash } from './sanity.ts';

/** Files per ingest_files call. Derived from wire size, not "how many mutations is reasonable" the
 *  way lifecycle.ts's MAX_BATCH_PAGES is — a batch item here is up to 25 MB of file bytes, not a
 *  16-byte uuid. Worst-case body is K * ceil(MAX_FILE_BYTES * 4/3) ~= K * 33.3MB, buffered whole by
 *  express.json() BEFORE any file reaches the extraction admission gate — memory the gate's own
 *  MAX_CONCURRENT/MAX_WAITING accounting (src/ingest/extract/index.ts) does not include. At 10 that
 *  is a ~333MB worst case; in practice lower, since the web UI submits in chunks of
 *  BATCH_INGEST_CONCURRENCY. Recompute from the formula above before raising this. */
export const MAX_BATCH_FILES = 10;

/** Internal concurrency for one ingest_files call. Half of extract/index.ts's MAX_CONCURRENT=6 — a
 *  single batch request can never claim more than half the (global, process-local, not
 *  per-workspace) admission gate, always leaving slots for every other concurrent user. Each
 *  importFile call also fans out to embedAll's own MAX_CONCURRENT_BATCHES=3 internally, so the worst
 *  case here is 3x3=9 simultaneous embedding calls — below the 6x3=18 ordinary uncoordinated
 *  single-file traffic can already produce today. */
// Exported so test/body-limits.test.ts can pin it against BatchUpload.tsx's CHUNK_SIZE, which the
// client sizes its own chunk-request width from FOR THIS EXACT REASON (see that constant's own
// comment) — the two drifting apart silently reopens either the rate-limiter-efficiency or the
// admission-gate-fairness argument that size was chosen for.
export const BATCH_INGEST_CONCURRENCY = 3;

export interface BatchIngestFileInput {
  filename: string;
  content_base64: string;
  slug: string;
  title?: string;
  tags?: string[];
  author?: string;
  metadata?: Record<string, unknown>;
  effectiveDate?: string;
}

export interface BatchIngestInput {
  files: BatchIngestFileInput[];
  /** Applies to EVERY file in the batch — one visibility decision for the whole call, not per file. */
  scope?: PageScope;
  kind?: PackKind;
}

/** One file's fate. `code` reuses OpErrorCode rather than inventing a parallel taxonomy the way
 *  lifecycle.ts's BatchOutcomeCode does: lifecycle.ts needed new codes (not_visible/not_author/...)
 *  because those outcomes have no OpErrorCode equivalent — importFile's failures already do
 *  (invalid_params, payload_too_large, extraction_failed, unsupported_format, already_exists,
 *  rate_limited). Reusing the set means a batch failure and a single-file ingest_file failure explain
 *  themselves identically. */
export interface BatchFileOutcome {
  filename: string;
  slug: string;
  ok: boolean;
  pageId?: string;
  chunkCount?: number;
  format?: string;
  unitsExtracted?: number;
  unitsSkipped?: number;
  degraded?: boolean;
  sha256?: string;
  code?: OpErrorCode;
  reason?: string;
  suggestion?: string;
}

export interface BatchIngestResult {
  outcomes: BatchFileOutcome[];
  succeeded: number;
  failed: number;
  /** True iff a SUCCESSFUL file's own `degraded` flag was set — same meaning as ingest_file's
   *  top-level `degraded`. Partial batch FAILURE (some outcomes ok:false) is a normal, expected
   *  partial-success shape reported via succeeded/failed, not "degraded" — don't conflate the two. */
  degraded: boolean;
}

export async function ingestFiles(ctx: OperationContext, input: BatchIngestInput): Promise<BatchIngestResult> {
  const { files } = input;
  if (files.length === 0) {
    throw new OperationError('invalid_params', 'no files given', 'Pass at least one file.');
  }
  if (files.length > MAX_BATCH_FILES) {
    throw new OperationError(
      'invalid_params',
      `${files.length} files is more than one call may ingest (limit ${MAX_BATCH_FILES})`,
      `Split into batches of ${MAX_BATCH_FILES} or fewer.`,
    );
  }

  const outcomes = new Array<BatchFileOutcome>(files.length);

  // Hash every file up front to find intra-batch duplicates — but this decode is TRANSIENT, not
  // retained. Each file's own bytes are re-decoded lazily inside the worker loop below, right before
  // that file's turn to run. Holding one decoded copy per file for the batch's whole lifetime (up to
  // MAX_BATCH_FILES=10 * 25MB ~= 250MB, on top of the ~333MB of base64 express.json already buffered)
  // was memory the extraction admission gate's own MAX_CONCURRENT/MAX_WAITING accounting
  // (src/ingest/extract/index.ts) never priced in — a file sitting in the queue behind slower ones
  // could hold its full decoded bytes for minutes. Re-decoding at worker time bounds decoded-bytes-
  // in-memory to roughly BATCH_INGEST_CONCURRENCY files at once, not all of them; base64-decoding a
  // file twice is negligible next to its extraction/embedding cost.
  //
  // Buffer.from is lenient on invalid base64 (ignores out-of-alphabet characters rather than
  // throwing — same behavior ingest_file's own handler already relies on), so the only failure mode
  // here is decoding to zero bytes, not a thrown decode error.
  const firstIndexOfHash = new Map<string, number>();
  const hashOfIndex = new Map<number, string>();
  files.forEach((f, i) => {
    const bytes = Buffer.from(f.content_base64, 'base64');
    if (bytes.byteLength === 0) {
      outcomes[i] = {
        filename: f.filename,
        slug: f.slug,
        ok: false,
        code: 'invalid_params',
        reason: `content_base64 for "${f.filename}" decoded to zero bytes`,
      };
      return;
    }
    const h = contentHash(bytes);
    hashOfIndex.set(i, h);
    if (!firstIndexOfHash.has(h)) firstIndexOfHash.set(h, i);
  });

  // Intra-batch dedup: two identical files in ONE submission would otherwise race on the 23505 path
  // inside importFile (its pre-embed SELECT can't see another uncommitted transaction), both paying
  // for extraction+embedding before one loses. Cheap to catch here — the hash is already about to be
  // computed again by importFile itself for the file that runs.
  const toRun: number[] = [];
  files.forEach((f, i) => {
    if (outcomes[i]) return; // already a zero-byte outcome
    const first = firstIndexOfHash.get(hashOfIndex.get(i)!)!;
    if (first !== i) {
      outcomes[i] = {
        filename: f.filename,
        slug: f.slug,
        ok: false,
        code: 'already_exists',
        reason: `identical to "${files[first]!.filename}" earlier in this same batch`,
        suggestion: 'Remove the duplicate and resubmit.',
      };
    } else {
      toRun.push(i);
    }
  });

  // Worker pool — the same shared-counter idiom embedAll (src/ingest/embed.ts) already uses, applied
  // to whole importFile calls instead of embedding batches. Deliberately NO "failed" flag the way
  // embedAll has one: embedAll fails fast because a document needs ALL its vectors or none; a batch
  // of files must keep going after one file's failure.
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = toRun[next++];
      if (i === undefined) return;
      const f = files[i]!;
      try {
        const bytes = new Uint8Array(Buffer.from(f.content_base64, 'base64'));
        const r = await importFile(ctx, {
          bytes,
          filename: f.filename,
          slug: f.slug,
          title: f.title,
          tags: f.tags,
          scope: input.scope,
          kind: input.kind,
          author: f.author,
          metadata: f.metadata,
          effectiveDate: f.effectiveDate,
        });
        outcomes[i] = {
          filename: f.filename,
          slug: r.slug,
          ok: true,
          pageId: r.pageId,
          chunkCount: r.chunkCount,
          format: r.format,
          unitsExtracted: r.unitsExtracted,
          unitsSkipped: r.unitsSkipped,
          degraded: r.degraded,
          sha256: r.sha256,
        };
      } catch (err) {
        // Never rethrow — one file's failure, expected or not, must not lose the rest of the batch.
        outcomes[i] = toOutcome(f, err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(BATCH_INGEST_CONCURRENCY, toRun.length) }, worker));

  const succeeded = outcomes.filter((o) => o.ok).length;
  return {
    outcomes,
    succeeded,
    failed: outcomes.length - succeeded,
    degraded: outcomes.some((o) => o.ok && o.degraded === true),
  };
}

function toOutcome(f: BatchIngestFileInput, err: unknown): BatchFileOutcome {
  if (err instanceof OperationError) {
    return {
      filename: f.filename,
      slug: f.slug,
      ok: false,
      code: err.code,
      reason: err.message,
      suggestion: err.suggestion,
    };
  }
  console.error(`[ingest_files] unexpected error ingesting "${f.filename}":`, err);
  return {
    filename: f.filename,
    slug: f.slug,
    ok: false,
    code: 'internal_error',
    reason: 'internal error ingesting this file — reference server logs',
  };
}
