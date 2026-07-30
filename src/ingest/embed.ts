// Batched embedding.
//
// `embed()` in the router takes an array and sends it as ONE request. That works for a pasted note
// and fails for a real document: a 200-page PDF is ~1,500 chunks, and one request carrying all of
// them exceeds the provider's input limit, blows past EMBED_TIMEOUT_MS, and — because the ingest
// waist embeds before opening its transaction — throws away every chunk that had already been paid
// for. This splits the work into requests that can actually return, and reassembles them in an order
// that cannot be wrong.
import { embed } from '../ai/router.ts';
import { OperationError } from '../api/errors.ts';
import { estimateTokens } from './chunk.ts';

/** Items per request. Well under the provider's array limit; the token bound below usually binds first. */
export const MAX_BATCH_ITEMS = 64;

/** Token budget per request. NOT the provider's ~300k ceiling — a batch that large cannot return
 *  inside EMBED_TIMEOUT_MS (60s), so the ceiling that matters is the one the clock imposes. */
export const MAX_BATCH_TOKENS = 20_000;

/** Hard per-input ceiling. text-embedding-3-small accepts 8192 tokens; the headroom absorbs the
 *  error in a bytes/4 estimate, which under-counts for scripts it was not calibrated on. */
export const MAX_INPUT_TOKENS = 7_500;

/** Requests in flight at once. Enough to hide latency on an intercontinental link, low enough not to
 *  become the thing that trips the provider's rate limiter — the router retries a 429, but a retry
 *  storm we caused ourselves is latency we chose. */
const MAX_CONCURRENT_BATCHES = 3;

export interface Batch {
  /** Inclusive index into the original array. */
  start: number;
  /** Exclusive. */
  end: number;
}

/**
 * Split `texts` into request-sized runs of CONSECUTIVE items.
 *
 * Pure and exported so the batching rules are unit-testable without a provider — the alternative is
 * discovering an off-by-one in production, on a document large enough to have been batched, which is
 * exactly the document you least want to re-ingest.
 *
 * Consecutive, never re-ordered or grouped by size: the caller writes results back by absolute index,
 * and that only works if a batch is a contiguous slice.
 */
export function planBatches(texts: readonly string[]): Batch[] {
  const batches: Batch[] = [];
  let start = 0;
  let tokens = 0;

  for (let i = 0; i < texts.length; i++) {
    const t = estimateTokens(texts[i]!);
    // A single item at or over the budget gets its own request. Closing the current batch FIRST
    // keeps items in order; without that the oversized item would either join a full batch or force
    // the ones before it into a later one.
    const wouldOverflow = i > start && (i - start >= MAX_BATCH_ITEMS || tokens + t > MAX_BATCH_TOKENS);
    if (wouldOverflow) {
      batches.push({ start, end: i });
      start = i;
      tokens = 0;
    }
    tokens += t;
  }
  if (start < texts.length) batches.push({ start, end: texts.length });
  return batches;
}

/**
 * Embed every text, in batches, returning vectors in the SAME ORDER as the input.
 *
 * The ordering guarantee is the whole point of this function, and it is enforced twice because the
 * failure is silent. A chunk stored with another chunk's vector does not error, does not look wrong
 * in the database, and does not show up until someone notices that search returns the wrong
 * paragraph — by which time the corpus has been re-ingested and the evidence is gone.
 *
 *   1. Results are written to a PREALLOCATED array at an absolute offset (`batch.start + j`), never
 *      pushed and never sorted after concatenation. Batches finish out of order — that is the point
 *      of running them concurrently — so append order is not input order.
 *   2. Every slot is checked at the end. A provider that returns a duplicated `index` within one
 *      batch leaves one hole and one double-write; the router's own count check passes, because the
 *      COUNT is right. The hole is the only observable trace.
 */
export async function embedAll(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  // Fail before spending anything. If this fires the chunker is broken, not the document: the sanity
  // gate already rejects 2,000-character unbroken tokens and chunkBlocks enforces a hard cap, so an
  // oversized item means an invariant upstream stopped holding. Deliberately not dressed as a 4xx —
  // telling a user to fix their file would be pointing at the wrong thing.
  //
  // Typed, though, and that is not the same question. Blame belongs to us; the CALLER still has to
  // decide what to do, and the caller is often an MCP agent that cannot read a server log. A bare
  // Error became `internal_error` with "reference reqId <uuid>", which an agent reads as transient —
  // so it re-uploaded the same 5 MB spreadsheet and re-paid for every batch that had succeeded.
  // Same 500, same blame, but the suggestion now says the one thing the agent needs: do not retry.
  for (let i = 0; i < texts.length; i++) {
    const t = estimateTokens(texts[i]!);
    if (t > MAX_INPUT_TOKENS) {
      throw new OperationError(
        'internal_error',
        `embedAll: chunk ${i} is ~${t} tokens, over the ${MAX_INPUT_TOKENS} per-input limit. ` +
          `The chunker should have split this; treat it as a bug in chunkBlocks, not in the document.`,
        'This is a defect in our chunker, not a problem with your file. Retrying the same upload will ' +
          'fail identically — report the reqId instead.',
      );
    }
  }

  const batches = planBatches(texts);
  const out = new Array<number[] | undefined>(texts.length);

  let nextBatch = 0;
  // Set by the first worker to fail. Without it the siblings keep pulling batches and PAYING for
  // them after the request has already thrown: a 200-page PDF plans ~45 batches, so a failure on
  // the first one still billed for the rest. Promise.all rejects on the first error but does not
  // cancel the others — that is the caller's job, and this is the caller.
  let failed = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (failed) return;
      const i = nextBatch++;
      const batch = batches[i];
      if (!batch) return;
      const slice = texts.slice(batch.start, batch.end);
      let vectors: number[][];
      try {
        vectors = await embed(slice);
      } catch (e) {
        failed = true;
        throw e;
      }
      // The router already asserts count-per-request and vector width; this asserts the shape of the
      // answer AT THIS SEAM, where an off-by-one in planBatches would land instead.
      if (vectors.length !== slice.length) {
        failed = true;
        throw new Error(`embedAll: batch ${i} asked for ${slice.length} vectors and got ${vectors.length}`);
      }
      for (let j = 0; j < vectors.length; j++) out[batch.start + j] = vectors[j]!;
    }
  };

  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_BATCHES, batches.length) }, worker));

  const hole = out.findIndex((v) => v === undefined);
  if (hole !== -1) {
    throw new Error(
      `embedAll: no vector for chunk ${hole} of ${texts.length}. A batch returned a duplicated index, ` +
        `so one input was embedded twice and this one not at all.`,
    );
  }
  return out as number[][];
}
