// The file-ingest waist: bytes -> detect -> extract -> sanity -> chunk -> embed -> ONE transaction.
//
// NO OPERATION HERE TAKES A SERVER FILESYSTEM PATH, and that is not a style choice. Operations are
// published at /api/_ops, which is unauthenticated (D53), and every op is callable by any `member` —
// a role domain auto-join hands to any Workspace account on a claimed domain. An op accepting
// `{"path": "..."}` would therefore let a caller say `/proc/self/environ` and have the server ingest
// OPENAI_API_KEY, DATABASE_URL, CB_APP_DB_PASSWORD and SESSION_SECRET into a page — which `ask`
// would then happily read back out. Bytes come from the caller, always.
import { withScopedTx } from '../db/client.ts';
import { withRouterScope } from '../ai/router.ts';
import { toVectorLiteral } from '../ai/vector.ts';
import type postgres from 'postgres';
import { aclForScope, DEFAULT_PAGE_SCOPE, type OperationContext, type PageScope } from '../core/context.ts';
import { DEFAULT_PACK_KIND, type PackKind } from '../core/pack.ts';
import { OperationError } from '../api/errors.ts';
import { extractFile, withUploadSlot } from './extract/index.ts';
import { assessExtraction, contentHash, sanitySuggestion } from './sanity.ts';
import { deriveEffectiveDate, textHash as computeTextHash } from './provenance.ts';
import { chunkBlocks, estimateTokens, CHUNKER_VERSION } from './chunk.ts';
import { embedAll } from './embed.ts';

export interface ImportFileInput {
  bytes: Uint8Array;
  filename: string;
  slug: string;
  title?: string;
  tags?: string[];
  scope?: PageScope;
  kind?: PackKind;
  /** Who WROTE the document (not who uploaded it — see pages.author's migration comment). */
  author?: string;
  /** Unstructured metadata bag. Bounded to 10KB at the op boundary (src/api/operations.ts). */
  metadata?: Record<string, unknown>;
  /** ISO date (YYYY-MM-DD) the document is ABOUT. Omit to default to the upload date. */
  effectiveDate?: string;
}

export interface ImportFileResult {
  pageId: string;
  slug: string;
  chunkCount: number;
  format: string;
  /** Units the extractor read (pages, sheets, rows) and units it could not. */
  unitsExtracted: number;
  unitsSkipped: number;
  /** True when enough of the document failed to extract that the result is worth doubting. */
  degraded: boolean;
  sha256: string;
}

/** Bytes accepted per file, on the DECODED bytes.
 *
 *  25 MB, raised from 5 MB after auditing a real corpus: TEN of ten PDFs were refused, including
 *  arXiv papers at 9-45 MB and the company's own 6.8 MB project proposal. A knowledge brain for a
 *  research team that cannot accept a single research paper is not a knowledge brain.
 *
 *  This number is NOT free, and the cost is memory rather than disk. Extraction admits
 *  MAX_CONCURRENT running plus MAX_WAITING queued (src/ingest/extract/index.ts), and each of those
 *  retains ~5.33x the file size at its peak — see that file for the four terms. At 25 MB that is
 *  ~133 MB per in-flight upload, so the gate width and this constant multiply directly into the
 *  process's memory ceiling.
 *
 *  THOSE CONSTANTS ARE COUPLED, and prose is a weak binding for a cross-file invariant — so
 *  test/extract-admission.test.ts asserts the product against the deployment's actual memory.
 *  Raising this without lowering the gate width fails the suite instead of the host.
 *
 *  Still refused at this cap: the 26-45 MB tail (4 of the 10 audited). Those need a streaming or
 *  chunked upload path, not a bigger number — 45 MB is 60 MB of base64 in one JSON body. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Most chunks one document may produce, derived from the Postgres wire protocol rather than chosen.
 *
 *  The chunk insert binds INSERT_COLUMNS parameters per row in one multi-row statement, and a
 *  protocol message caps at 65,534 parameters — postgres.js throws rather than splitting. Floored
 *  with headroom so a column added to that insert shrinks the bound automatically instead of turning
 *  it into a lie. UPDATE THIS when the insert's column list changes — migration 0014 added three
 *  (effective_date, author, chunker_version), which is exactly the case this comment warns about. */
const INSERT_COLUMNS = 12; // workspace_id, page_id, acl, tags, ord, content, token_count, locator, embedding, effective_date, author, chunker_version
const MAX_CHUNKS_PER_INSERT = Math.floor(65_534 / INSERT_COLUMNS);

export async function importFile(ctx: OperationContext, input: ImportFileInput): Promise<ImportFileResult> {
  // ONE admission slot for the WHOLE upload, not just the parse. See withUploadSlot for why the
  // extract-only gate bounded the wrong phase. The cheap size checks run outside it so an oversized
  // file is refused without ever queuing behind real work.
  if (input.bytes.byteLength === 0) {
    throw new OperationError('invalid_params', 'the uploaded file is empty');
  }
  if (input.bytes.byteLength > MAX_FILE_BYTES) {
    throw new OperationError(
      'payload_too_large',
      `file is ${(input.bytes.byteLength / 1_048_576).toFixed(1)} MB; the limit is ${MAX_FILE_BYTES / 1_048_576} MB`,
      'Split the document, or paste the relevant section as text.',
    );
  }

  return withUploadSlot(() => importFileAdmitted(ctx, input));
}

async function importFileAdmitted(ctx: OperationContext, input: ImportFileInput): Promise<ImportFileResult> {
  const scope = input.scope ?? DEFAULT_PAGE_SCOPE;
  const acl = aclForScope(scope, ctx);
  const kind = input.kind ?? DEFAULT_PACK_KIND;
  const tags = input.tags ?? [];
  const sha256 = contentHash(input.bytes);
  const { effectiveDate, effectiveDateSource } = deriveEffectiveDate(input.effectiveDate);

  // 1. Extract, in the hardened subprocess. Throws typed errors (unsupported_format,
  //    extraction_failed, payload_too_large) that reach the caller as themselves, never as a 500.
  const extracted = await extractFile(input.bytes, input.filename, { admitted: true });

  // 2. Sanity gate — AFTER extraction, BEFORE embedding. Every rejection here is money not spent on
  //    a document that was never going to be retrievable.
  const verdict = assessExtraction(extracted);
  if (!verdict.ok) {
    // The rejection is RECORDED before it is thrown, on the caller's own scoped transaction, so the
    // row lands with the acl the caller asked for (D72) and a false reject stays inspectable instead
    // of vanishing with the response.
    //
    // BEST-EFFORT, deliberately. Recording the verdict must not be able to change the verdict the
    // caller receives: without this catch, a failed audit insert (lock_timeout, the reason CHECK
    // drifting from SanityReason, disk pressure) replaces a clean 422-with-remediation with a raw
    // Postgres error the user cannot act on — the audit trail eating the diagnosis it exists to
    // support.
    try {
      await withScopedTx(ctx, (tx) => tx`
        insert into quarantine (workspace_id, owner_principal, acl, filename, source_format, sha256, byte_len, reason, detail)
        values (${ctx.workspaceId}, ${ctx.principal}, ${acl}, ${input.filename}, ${extracted.format},
                ${sha256}, ${input.bytes.byteLength}, ${verdict.reason}, ${verdict.detail})`);
    } catch (e) {
      console.error(`[ingest] quarantine record failed for ${input.filename}: ${(e as Error).message}`);
    }
    throw new OperationError('extraction_failed', verdict.detail, sanitySuggestion(verdict.reason));
  }

  // 3. Chunk from BLOCKS, not from flattened text: this is what carries page and sheet locators
  //    through to the citation, and what keeps a spreadsheet row attached to its header.
  const chunks = chunkBlocks(extracted.blocks);
  if (chunks.length === 0) {
    throw new OperationError('extraction_failed', 'the document produced no chunks after extraction');
  }
  // Refused HERE, before the embedding spend, because the wall it protects is otherwise hit at the
  // very last statement of the whole pipeline.
  //
  // The chunk insert below binds 9 columns per row into ONE multi-row statement, and the Postgres
  // wire protocol caps a message at 65,534 parameters — postgres.js throws "Max number of parameters
  // (65534) exceeded" rather than splitting. That is 65534/9 = 7,281 chunks. At ~600 tokens per
  // chunk it was unreachable under the old 5 MB cap (worst case ~2,400 chunks, 3x of headroom) and
  // is reachable at 25 MB, where a text-ish file extracts close to 1:1 and can produce ~12,000.
  //
  // Without this the failure lands at step 5 of 5: every embedding billed, minutes burned, and an
  // untyped 500 for a file that passed every upstream check. The same shape as §6.9's over-cap
  // chunks, and reachable for the same reason — a bound that moved without its dependents.
  if (chunks.length > MAX_CHUNKS_PER_INSERT) {
    throw new OperationError(
      'payload_too_large',
      `this document produced ${chunks.length.toLocaleString()} passages; the limit is ${MAX_CHUNKS_PER_INSERT.toLocaleString()} in one document`,
      'Split it into several files. A document this dense is also unlikely to retrieve well as one page.',
    );
  }

  // 4. Refuse a duplicate BEFORE paying to embed it.
  //
  // Re-uploading a file you already have is the single most ordinary user action, and until this
  // check existed it was also the most expensive: the 23505 handler below is the only thing that
  // catches it, and by then every chunk of a 200-page PDF has been embedded and billed. replacePage
  // already refuses before its embed call and has a test asserting the counter stayed at zero
  // (test/lifecycle.test.ts, "refuses before spending an embedding call"); this brings the file path
  // in line with it.
  //
  // This is an optimisation, NOT the guard: two concurrent uploads of the same bytes both pass here
  // and one loses at the unique index. The 23505 handler below stays as the real backstop.
  //
  // The predicate MIRRORS THE PARTIAL INDEXES EXACTLY, and getting that wrong is how this check
  // first shipped: a bare `source_sha256 = $1 OR slug = $2` refuses uploads the database would
  // happily accept. Both index pairs (0007 for slug, 0009 for sha) are partial on `scope`, and the
  // private one is additionally per-author — so the SAME file may legitimately exist as a shared
  // page AND as any number of principals' private pages. Rejecting that would quietly undo D68/D73,
  // which split those indexes precisely so a private upload is not constrained by a shared one it
  // cannot even see.
  const isPrivate = scope === 'private';
  const dupe = await withScopedTx(ctx, (tx) => tx<{ slug: string; by_sha: boolean }[]>`
    select slug, (source_sha256 = ${sha256}) as by_sha
    from pages
    where scope = ${scope}
      and (${isPrivate} = false or owner_principal = ${ctx.principal})
      and (source_sha256 = ${sha256} or slug = ${input.slug})
    limit 1`);
  if (dupe.length > 0) {
    const bySha = dupe[0]!.by_sha;
    throw new OperationError(
      'already_exists',
      bySha
        ? isPrivate
          ? 'you have already uploaded this exact file'
          : 'this exact file has already been uploaded to this workspace'
        : `a page with slug "${input.slug}" already exists`,
      // Deliberately does NOT echo the colliding page's slug when the match was by CONTENT hash: the
      // row is visible to this caller (RLS filtered the select) but naming it still turns a
      // duplicate-upload message into a "what else is in here" probe. D73's reasoning, one layer up.
      bySha
        ? 'Search for it instead, or delete the existing page if you meant to replace it.'
        : 'Choose a different slug, or delete the existing page first.',
    );
  }

  // 5. Embed OUTSIDE any transaction (D6), batched (D80).
  const embeddings = await withRouterScope({ workspaceId: ctx.workspaceId, zdr: false }, () =>
    embedAll(chunks.map((c) => c.text)),
  );

  const extractedText = extracted.blocks.map((b) => b.text).join('\n\n');
  // Distinct from `sha256` above (the ORIGINAL UPLOADED BYTES, for pre-embed dedup). content_hash is
  // over the EXTRACTED TEXT — see provenance.ts's textHash() for why it means the same thing on both
  // ingest paths. No consumer yet; see migration 0014.
  const textHash = computeTextHash(extractedText);

  // 5. One transaction: page + source bytes + chunks, or none of them.
  return withScopedTx(ctx, async (tx) => {
    let rows: { id: string }[];
    try {
      rows = await tx<{ id: string }[]>`
        insert into pages (
          workspace_id, slug, title, kind, tags, owner_principal, scope, acl,
          source_format, source_meta, source_sha256, extracted_text, extractor,
          author, metadata, effective_date, effective_date_source, content_hash
        )
        values (
          ${ctx.workspaceId}, ${input.slug}, ${input.title ?? extracted.title ?? input.filename}, ${kind},
          ${tags}, ${ctx.principal}, ${scope}, ${acl},
          ${extracted.format}, ${tx.json(extracted.meta)}, ${sha256}, ${extractedText}, ${extracted.extractor},
          ${input.author ?? null}, ${input.metadata ? tx.json(input.metadata as postgres.JSONValue) : null},
          ${effectiveDate}, ${effectiveDateSource}, ${textHash}
        )
        returning id`;
      // `body` is deliberately absent from that insert, not set to null by accident: migration 0009's
      // column comment records that a file-sourced page keeps its text in extracted_text, which
      // carries different semantics (derived, re-derivable, parser-versioned).
    } catch (err) {
      const e = err as { code?: string; constraint_name?: string };
      // Index names renamed by migration 0018 (adds `AND deleted_at IS NULL` so a soft-deleted
      // page's file hash becomes reusable) — this check must track the "_live" names, not 0009's
      // original ones.
      if (e.code === '23505' && (e.constraint_name === 'pages_sha_shared_live' || e.constraint_name === 'pages_sha_private_live')) {
        throw new OperationError(
          'already_exists',
          e.constraint_name === 'pages_sha_shared_live'
            ? 'this exact file has already been uploaded to this workspace'
            : 'you have already uploaded this exact file',
          // Never echoes the colliding page's slug or title: for the private index the collision is
          // with the caller's own row, but for the shared one it need not be, and naming it would
          // reopen D73 on the axis D73 closed.
          'Search for it instead, or delete the existing page if you meant to replace it.',
        );
      }
      if (e.code === '23505') {
        throw new OperationError(
          'already_exists',
          `a page with slug "${input.slug}" already exists`,
          'Choose a different slug, or delete the existing page first.',
        );
      }
      throw err;
    }
    const pageId = rows[0]?.id;
    if (!pageId) throw new Error('importFile: page insert returned no id');

    // The original bytes, in the same transaction as the page (D71). acl is denormalized from the
    // same `acl` computed above rather than re-derived, so the two cannot disagree at birth.
    await tx`
      insert into page_sources (page_id, workspace_id, acl, filename, sha256, byte_len, bytes)
      values (${pageId}, ${ctx.workspaceId}, ${acl}, ${input.filename}, ${sha256}, ${input.bytes.byteLength},
              ${Buffer.from(input.bytes)})`;

    const values = chunks.map((chunk, i) => ({
      workspace_id: ctx.workspaceId,
      page_id: pageId,
      acl,
      tags,
      ord: i,
      content: chunk.text,
      // The BYTE-based estimate, not `text.length / 4`: the latter under-counts Devanagari and Tamil
      // by ~4x, and this column is what a future re-embed would size batches from.
      token_count: estimateTokens(chunk.text),
      // The OBJECT, not JSON.stringify(it). postgres.js serializes objects for json/jsonb columns
      // itself, so pre-stringifying double-encodes: what lands is the jsonb STRING SCALAR
      // `"{\"kind\":\"sheet\",...}"` rather than an object, and `locator ? 'kind'` is false on a
      // scalar — which is exactly what migration 0009's chunks_locator_shape CHECK caught here.
      locator: chunk.locator ?? null,
      embedding: toVectorLiteral(embeddings[i]!),
      // Denormalized from the page (D4's reasoning — see migration 0014's header): hybridSearch scans
      // this table directly with no per-arm join to pages.
      effective_date: effectiveDate,
      author: input.author ?? null,
      chunker_version: CHUNKER_VERSION,
    }));
    await tx`
      insert into content_chunks ${tx(values, 'workspace_id', 'page_id', 'acl', 'tags', 'ord', 'content', 'token_count', 'locator', 'embedding', 'effective_date', 'author', 'chunker_version')}`;

    return {
      pageId,
      slug: input.slug,
      chunkCount: chunks.length,
      format: extracted.format,
      unitsExtracted: extracted.unitsExtracted,
      unitsSkipped: extracted.unitsSkipped,
      // Passed through rather than swallowed: a 40-page PDF where 37 pages were scans looks exactly
      // like a clean 3-page ingest from the outside, and only this field says otherwise.
      degraded: verdict.degraded,
      sha256,
    };
  });
}

