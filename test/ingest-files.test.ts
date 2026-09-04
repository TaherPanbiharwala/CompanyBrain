// ingest_files: the batch form of importFile — orchestration and outcome aggregation, not a new
// pipeline. The property that matters most here is the one lifecycle-batch.test.ts already
// established for deletePages/rescopePages: these ops PARTITION rather than abort. Unlike those,
// there is no permission dimension to test — ingest_files only CREATES pages, so the only gate is
// the op-level requiredRole:'member' check, identical to ingest_file today.
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { liveOrFail, hasDbEnv } from './helpers/live.ts';
import { installFakeAiFetch } from './helpers/fake-ai.ts';
import { adminSql, closePools } from '../src/db/client.ts';
import { buildContext, resolveGrants, type OperationContext } from '../src/core/context.ts';
import { ingestFiles, MAX_BATCH_FILES, type BatchIngestFileInput } from '../src/ingest/batch.ts';
import { dispatchOp } from '../src/api/dispatch.ts';
import { operationsByName, operations } from '../src/api/operations.ts';
import { config } from '../src/config.ts';

const RUN = crypto.randomUUID().slice(0, 8);
const DIR = join(new URL('.', import.meta.url).pathname, 'fixtures', 'formats');
const HAVE = existsSync(join(DIR, 'sample.csv')) && existsSync(join(DIR, 'sample.bin'));
const bytes = (n: string): Uint8Array => new Uint8Array(readFileSync(join(DIR, n)));
const b64 = (n: string): string => Buffer.from(bytes(n)).toString('base64');
// Folded in, same reason ingest-file.test.ts's own HAVE check is: a missing fixture must SKIP this
// whole suite as unrun, not report green, so CB_REQUIRE_LIVE_TESTS=1 catches the gap rather than a
// false pass.
const live = liveOrFail('ingest-files', hasDbEnv() && HAVE);
const mutableConfig = config as unknown as Record<string, unknown>;

/** A batch file entry from a fixture, base64-encoded — the shape ingest_files actually consumes. */
function file(name: string, slug: string, filename = name): BatchIngestFileInput {
  return { filename, content_base64: b64(name), slug: `${slug}-${RUN}` };
}

/** A file whose CONTENT is unique to this call, not just its slug or filename. Every test in this
 *  file shares one workspace, and importFile's pre-embed dedup (and the unique-index backstop behind
 *  it) matches on content sha256 within a scope — reusing the SAME fixture bytes as a "good" file
 *  across two different tests would collide as `already_exists` against an earlier test's own
 *  ingest, not against anything this test is trying to assert. Plain text — falls through
 *  detect.ts's textualKind() to 'text', a supported format — long enough and word-bounded enough to
 *  clear the sanity gate. `sample.bin`/synthetic junk bytes used elsewhere in this file are exempt
 *  from this concern: unsupported_format and extraction_failed are both thrown before importFile
 *  ever reaches the dedup check, so reusing THOSE across tests is safe by construction. */
function uniqueFile(tag: string, filename = `${tag}.txt`): BatchIngestFileInput {
  const body = `Document ${tag} for run ${RUN}, marker ${crypto.randomUUID()}. Unique prose content, ` +
    'long enough and with enough word boundaries to clear the sanity gate for automated batch ' +
    'ingest testing.';
  return { filename, content_base64: Buffer.from(body, 'utf8').toString('base64'), slug: `${tag}-${RUN}` };
}

describe.skipIf(!live)('ingestFiles — the batch orchestration layer', () => {
  let ws = '';
  let pA = '';
  const realFetch = globalThis.fetch;
  const realKey = mutableConfig.OPENAI_API_KEY;

  const ctxA = (): OperationContext =>
    buildContext({ principal: pA, workspaceId: ws, role: 'owner', grants: resolveGrants(pA, ws), remote: false });

  beforeAll(async () => {
    mutableConfig.OPENAI_API_KEY = 'test-key';
    globalThis.fetch = installFakeAiFetch();
    const admin = adminSql();
    pA = (
      await admin<{ id: string }[]>`
        insert into principals (email, email_normalized)
        values (${`bf-a-${RUN}@ex.com`}, ${`bf-a-${RUN}@ex.com`}) returning id`
    )[0]!.id;
    ws = (await admin<{ id: string }[]>`
      insert into workspaces (name, created_by) values (${`bf-ws-${RUN}`}, ${pA}) returning id`)[0]!.id;
    await admin`insert into workspace_members (workspace_id, principal_id, role) values (${ws}, ${pA}, 'owner')`;
  }, 120_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    mutableConfig.OPENAI_API_KEY = realKey;
    const admin = adminSql();
    await admin`delete from workspaces where id = ${ws}`;
    await admin`delete from principals where id = ${pA}`;
    await closePools({ timeout: 5 });
  }, 60_000);

  it('refuses an empty file list, at both the handler and the dispatch level', async () => {
    await expect(ingestFiles(ctxA(), { files: [] })).rejects.toThrow(/no files given/);
    // The double-check convention deletePages/rescopePages already use: zod's own .min(1) must ALSO
    // reject it, so a caller that bypasses the handler (a future direct SQL RPC, a schema change that
    // loosens the handler check) still cannot slip an empty batch through the published contract.
    const r = await dispatchOp(ctxA(), 'ingest_files', { files: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_params');
  }, 30_000);

  it('refuses more than MAX_BATCH_FILES, before touching the database', async () => {
    const tooMany = Array.from({ length: MAX_BATCH_FILES + 1 }, (_, i) => file('sample.csv', `over-${i}`));
    await expect(ingestFiles(ctxA(), { files: tooMany })).rejects.toThrow(/more than one call may ingest/);
  }, 30_000);

  it('accepts exactly MAX_BATCH_FILES — the boundary the over-limit test above does not cover', async () => {
    const exact = Array.from({ length: MAX_BATCH_FILES }, (_, i) => uniqueFile(`exact-cap-${i}`));
    const r = await ingestFiles(ctxA(), { files: exact });
    expect(r.outcomes).toHaveLength(MAX_BATCH_FILES);
    expect(r.succeeded).toBe(MAX_BATCH_FILES);
  }, 120_000);

  it('a duplicate file within the same batch is refused without paying to embed it twice', async () => {
    let embedCalls = 0;
    const counting = installFakeAiFetch();
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('embed')) embedCalls++;
      return counting(input as never, init as never);
    }) as typeof fetch;
    try {
      // Baseline FIRST: exactly how many embedding calls one clean small-file ingest costs. Without
      // this, asserting only "the dup batch made >0 calls" would also pass if the dedup check were
      // broken and BOTH copies reached the embedder — a bare ">0" cannot distinguish "embedded once"
      // from "embedded twice".
      const beforeBaseline = embedCalls;
      await ingestFiles(ctxA(), { files: [uniqueFile('dup-baseline')] });
      const costOfOneFile = embedCalls - beforeBaseline;
      expect(costOfOneFile, 'a clean single-file ingest did not reach the embedder — the counter is blind').toBeGreaterThan(0);

      const beforeDupBatch = embedCalls;
      const r = await ingestFiles(ctxA(), {
        files: [file('sample.html', 'dup-one', 'first.html'), file('sample.html', 'dup-two', 'second.html')],
      });
      expect(r.succeeded).toBe(1);
      expect(r.failed).toBe(1);
      const dupe = r.outcomes.find((o) => o.filename === 'second.html')!;
      expect(dupe.ok).toBe(false);
      expect(dupe.code).toBe('already_exists');
      expect(dupe.reason).toContain('first.html');
      // The spend, not just the outcome: the batch's total cost must equal exactly ONE file's worth,
      // not two — proving the duplicate never reached the embedder at all, not merely that it lost
      // afterward.
      const dupBatchCost = embedCalls - beforeDupBatch;
      expect(dupBatchCost, 'the duplicate was embedded before losing — dedup let both copies through').toBe(costOfOneFile);
    } finally {
      globalThis.fetch = counting;
    }
  }, 120_000);

  it('same slug, different content: both enter the worker pool and race on the DB unique index', async () => {
    // Intra-batch dedup only matches on CONTENT hash (src/ingest/batch.ts), never on slug — two files
    // sharing a slug but with distinct bytes both land in `toRun` and run concurrently through
    // separate importFile calls, relying entirely on the database's slug unique-index as the real
    // backstop (the same "optimisation, not the guard" property importFile's own pre-embed dedup has
    // for content). A folder upload with the same filename in two different subfolders is a realistic
    // way to reach exactly this, since BatchUpload derives each row's slug from the bare filename.
    const sharedSlug = `same-slug-${RUN}`;
    const files: BatchIngestFileInput[] = [
      { ...uniqueFile('slug-race-a', 'a.txt'), slug: sharedSlug },
      { ...uniqueFile('slug-race-b', 'b.txt'), slug: sharedSlug },
    ];
    const r = await ingestFiles(ctxA(), { files });
    expect(r.succeeded).toBe(1);
    expect(r.failed).toBe(1);
    const winner = r.outcomes.find((o) => o.ok)!;
    const loser = r.outcomes.find((o) => !o.ok)!;
    expect(winner.slug).toBe(sharedSlug);
    expect(loser.code).toBe('already_exists');
    expect(loser.reason).toContain(sharedSlug);
  }, 120_000);

  it('partial failure by content: one good file and one unsupported format both report, and the call still succeeds', async () => {
    const r = await ingestFiles(ctxA(), {
      files: [uniqueFile('partial-good', 'good.txt'), file('sample.bin', 'partial-bad', 'old.doc')],
    });
    expect(r.succeeded).toBe(1);
    expect(r.failed).toBe(1);
    const good = r.outcomes.find((o) => o.filename === 'good.txt')!;
    expect(good.ok).toBe(true);
    expect(good.pageId).toBeDefined();
    const bad = r.outcomes.find((o) => o.filename === 'old.doc')!;
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('unsupported_format');
  }, 120_000);

  it('content_base64 that decodes to zero bytes is its own per-file outcome, not a thrown error', async () => {
    // Buffer.from is lenient on invalid base64 (ignores out-of-alphabet characters rather than
    // throwing), so an empty or all-invalid-character string decodes to zero bytes rather than
    // failing to decode at all — this exercises that specific branch, paired with a good file to
    // confirm it partitions rather than aborting the batch.
    const r = await ingestFiles(ctxA(), {
      files: [uniqueFile('zero-bytes-good', 'good.txt'), { filename: 'empty.txt', content_base64: '', slug: `zero-bytes-${RUN}` }],
    });
    expect(r.succeeded).toBe(1);
    expect(r.failed).toBe(1);
    const good = r.outcomes.find((o) => o.filename === 'good.txt')!;
    expect(good.ok).toBe(true);
    const empty = r.outcomes.find((o) => o.filename === 'empty.txt')!;
    expect(empty.ok).toBe(false);
    expect(empty.code).toBe('invalid_params');
    expect(empty.reason).toContain('decoded to zero bytes');
  }, 60_000);

  it('every file failing still returns succeeded:0 with full outcomes, never a thrown error', async () => {
    const junk = Buffer.from('A'.repeat(3000), 'utf8').toString('base64');
    const r = await ingestFiles(ctxA(), {
      files: [
        { filename: 'bad1.doc', content_base64: b64('sample.bin'), slug: `all-fail-1-${RUN}` },
        { filename: 'bad2.txt', content_base64: junk, slug: `all-fail-2-${RUN}` },
      ],
    });
    expect(r.succeeded).toBe(0);
    expect(r.failed).toBe(2);
    expect(r.outcomes).toHaveLength(2);
    expect(r.outcomes.every((o) => !o.ok)).toBe(true);
  }, 60_000);

  it('a mixed batch reports full, order-preserving per-file detail', async () => {
    // Pre-seed one page so the fifth file collides against the DATABASE, not just within the batch.
    const preexisting = uniqueFile('mixed-preexisting', 'preexisting.json');
    await ingestFiles(ctxA(), { files: [preexisting] });

    const dupBody = uniqueFile('mixed-dup', 'dup-a.html');
    const files: BatchIngestFileInput[] = [
      uniqueFile('mixed-good', 'good.txt'),
      dupBody,
      { ...dupBody, filename: 'dup-b.html', slug: `mixed-dup-b-${RUN}` },
      file('sample.bin', 'mixed-bad', 'bad.doc'),
      { ...preexisting, slug: `mixed-preexisting-again-${RUN}` }, // same content, different slug
    ];
    const r = await ingestFiles(ctxA(), { files });
    expect(r.outcomes.map((o) => o.filename)).toEqual(files.map((f) => f.filename));
    expect(r.succeeded).toBe(2); // good.txt, dup-a.html
    expect(r.failed).toBe(3); // dup-b.html (intra-batch), bad.doc (format), preexisting.json (db collision)
    expect(r.outcomes.find((o) => o.filename === 'good.txt')!.ok).toBe(true);
    expect(r.outcomes.find((o) => o.filename === 'dup-a.html')!.ok).toBe(true);
    expect(r.outcomes.find((o) => o.filename === 'dup-b.html')!.code).toBe('already_exists');
    expect(r.outcomes.find((o) => o.filename === 'bad.doc')!.code).toBe('unsupported_format');
    expect(r.outcomes.find((o) => o.filename === 'preexisting.json')!.code).toBe('already_exists');
  }, 120_000);

  it('re-running an identical batch reports already_exists — a refusal, not a repeated success', async () => {
    // Different from rescopePages's idempotency convention (already-at-scope reports ok:true): a
    // duplicate file must never create a second page, so "safe to re-run" here means "every outcome
    // is a clean refusal", not "reports success twice".
    const batch = { files: [uniqueFile('idempotent'), uniqueFile('idempotent-2')] };
    const first = await ingestFiles(ctxA(), batch);
    expect(first.succeeded).toBe(2);

    const second = await ingestFiles(ctxA(), batch);
    expect(second.succeeded).toBe(0);
    expect(second.failed).toBe(2);
    expect(second.outcomes.every((o) => o.code === 'already_exists' && o.ok === false)).toBe(true);
  }, 120_000);

  it('every resulting page and chunk carries the calling workspace id', async () => {
    const r = await ingestFiles(ctxA(), {
      files: [uniqueFile('tenancy-a'), uniqueFile('tenancy-b')],
    });
    const pageIds = r.outcomes.filter((o) => o.ok).map((o) => o.pageId!);
    expect(pageIds.length).toBeGreaterThan(0);
    const admin = adminSql();
    const pages = await admin<{ workspace_id: string }[]>`
      select workspace_id from pages where id = any(${pageIds}::uuid[])`;
    expect(pages).toHaveLength(pageIds.length);
    for (const p of pages) expect(p.workspace_id).toBe(ws);
    const chunks = await admin<{ workspace_id: string }[]>`
      select workspace_id from content_chunks where page_id = any(${pageIds}::uuid[])`;
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) expect(c.workspace_id).toBe(ws);
  }, 120_000);
});

// ── The rule the op exists to enforce, asserted without a database ──────────
describe('the ingest_files op takes BYTES per file, never a path', () => {
  it('declares no path-like parameter, including inside the nested per-file schema', async () => {
    // Introspects the PUBLISHED contract (what buildToolDefs actually emits), not zod internals — the
    // published JSON-Schema is what an agent or the UI actually reads, and it is what would catch the
    // nested-.strict() gotcha noted in operations.ts: a z.object nested inside z.array needs its OWN
    // .strict() call, since the registry's auto-.strict() pass only reaches the top-level params
    // object.
    const { buildToolDefs } = await import('../src/api/tool-defs.ts');
    const defs = buildToolDefs(operations.filter((o) => !o.hidden));
    const def = defs.find((d) => d.name === 'ingest_files');
    expect(def, 'ingest_files is not published').toBeDefined();
    const props = (def!.inputSchema as { properties: Record<string, unknown> }).properties;
    const filesSchema = props.files as { items?: { properties?: Record<string, unknown>; additionalProperties?: boolean } };
    expect(filesSchema.items, 'ingest_files.files publishes no item schema').toBeDefined();
    const itemProps = filesSchema.items!.properties ?? {};
    expect(Object.keys(itemProps)).toContain('content_base64');
    for (const forbidden of ['path', 'file', 'filepath', 'file_path', 'url', 'uri', 'src']) {
      expect(Object.keys(itemProps), `ingest_files must not accept "${forbidden}" per file`).not.toContain(forbidden);
    }
    // The nested .strict() actually took effect — an unknown per-file key is rejected, not silently
    // stripped and reported as a successful ingest with the caller's field quietly discarded.
    expect(filesSchema.items!.additionalProperties, 'the per-file schema is not strict').toBe(false);
  });

  it('is registered and cross-referenced from ingest_file', () => {
    const files = operationsByName.ingest_files;
    expect(files, 'ingest_files is not registered').toBeDefined();
    expect(files!.mutating).toBe(true);
    expect(files!.description).toMatch(/base64/i);
    expect(operationsByName.ingest_file!.description).toContain('ingest_files');
  });
});
