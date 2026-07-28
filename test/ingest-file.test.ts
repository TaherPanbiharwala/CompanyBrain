// The file-ingest waist, end to end: bytes -> extract -> sanity -> chunk -> embed -> one row set.
//
// The XLSX case is the sharpest thing in this file, and it is the one the plan named as the gate:
// a value that exists ONLY in row 40 of the second sheet must come back with a sheet locator whose
// range contains row 40, and its column header attached. Everything between the upload and that
// assertion has to have worked.
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { liveOrFail, hasDbEnv } from './helpers/live.ts';
import { installFakeAiFetch } from './helpers/fake-ai.ts';
import { adminSql, withScopedTx, closePools } from '../src/db/client.ts';
import { buildContext, resolveGrants, type OperationContext } from '../src/core/context.ts';
import { importFile } from '../src/ingest/file.ts';
import { hybridSearch } from '../src/search/hybrid.ts';
import { operationsByName } from '../src/api/operations.ts';
import { OperationError } from '../src/api/errors.ts';
import { config } from '../src/config.ts';

const RUN = crypto.randomUUID().slice(0, 8);
const DIR = join(new URL('.', import.meta.url).pathname, 'fixtures', 'formats');
const HAVE = existsSync(join(DIR, 'sample.xlsx'));
const bytes = (n: string): Uint8Array => new Uint8Array(readFileSync(join(DIR, n)));
// The fixture check is folded INTO liveOrFail, not ANDed onto it. Written as
// `liveOrFail(...) && HAVE`, a missing fixture skipped this entire suite green even under
// CB_REQUIRE_LIVE_TESTS=1 — liveOrFail returned true, `&& HAVE` flipped it to false, and
// describe.skipIf swallowed the private-bytes leak case, the quarantine-filename case and the
// byte-retention case. Passing the condition through means a missing fixture THROWS under the flag,
// which is the whole contract of that flag (D43).
const live = liveOrFail('ingest-file', hasDbEnv() && HAVE);
const mutableConfig = config as unknown as Record<string, unknown>;

describe.skipIf(!live)('importFile — the waist', () => {
  let ws = '';
  let pA = '';
  let pB = '';
  const realFetch = globalThis.fetch;
  const realKey = mutableConfig.OPENAI_API_KEY;

  const ctxA = (): OperationContext =>
    buildContext({ principal: pA, workspaceId: ws, role: 'owner', grants: resolveGrants(pA, ws), remote: false });
  const ctxB = (): OperationContext =>
    buildContext({ principal: pB, workspaceId: ws, role: 'member', grants: resolveGrants(pB, ws), remote: false });

  beforeAll(async () => {
    mutableConfig.OPENAI_API_KEY = 'test-key';
    globalThis.fetch = installFakeAiFetch();
    const admin = adminSql();
    const mk = async (t: string) =>
      (await admin<{ id: string }[]>`
        insert into principals (email, email_normalized)
        values (${`if-${t}-${RUN}@ex.com`}, ${`if-${t}-${RUN}@ex.com`}) returning id`)[0]!.id;
    pA = await mk('a');
    pB = await mk('b');
    ws = (await admin<{ id: string }[]>`
      insert into workspaces (name, created_by) values (${`if-ws-${RUN}`}, ${pA}) returning id`)[0]!.id;
    await admin`insert into workspace_members (workspace_id, principal_id, role) values
      (${ws}, ${pA}, 'owner'), (${ws}, ${pB}, 'member')`;
  }, 120_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    mutableConfig.OPENAI_API_KEY = realKey;
    const admin = adminSql();
    await admin`delete from workspaces where id = ${ws}`;
    await admin`delete from principals where id in (${pA}, ${pB})`;
    await closePools({ timeout: 5 });
  }, 60_000);

  it('THE GATE: a value only in row 40 of sheet 2 is retrievable with its sheet locator and header', async () => {
    const r = await importFile(ctxA(), {
      bytes: bytes('sample.xlsx'),
      filename: 'sample.xlsx',
      slug: `gate-xlsx-${RUN}`,
    });
    expect(r.format).toBe('xlsx');
    expect(r.chunkCount).toBeGreaterThan(0);

    const { hits } = await hybridSearch(ctxA(), 'zzsentinelrow40');
    const hit = hits.find((h) => h.content.includes('zzsentinelrow40'));
    expect(hit, 'the row-40 sentinel is not retrievable — the waist lost it somewhere').toBeDefined();

    // The locator survived extraction, chunking, the jsonb column and the read path.
    const loc = hit!.locator as { kind: string; sheet: string; from: string; to: string } | null;
    expect(loc, 'the chunk came back with no locator').not.toBeNull();
    expect(loc!.kind).toBe('sheet');
    expect(loc!.sheet).toBe('Territories');
    // The RANGE must CONTAIN row 40 — chunks pack several rows, so an exact match would be the wrong
    // assertion and would fail a perfectly correct implementation.
    const rowOf = (ref: string) => Number(ref.replace(/[A-Z]/g, ''));
    expect(rowOf(loc!.from)).toBeLessThanOrEqual(40);
    expect(rowOf(loc!.to)).toBeGreaterThanOrEqual(40);

    // …and the header travelled with it, which is what makes a bare cell value mean anything.
    expect(hit!.content).toContain('Region');
  }, 180_000);

  it('retains the original bytes, byte-for-byte', async () => {
    const original = bytes('sample.pdf');
    const r = await importFile(ctxA(), { bytes: original, filename: 'sample.pdf', slug: `src-pdf-${RUN}` });
    const row = await withScopedTx(ctxA(), (tx) => tx<{ bytes: Buffer; sha256: string; byte_len: string }[]>`
      select bytes, sha256, byte_len from page_sources where page_id = ${r.pageId}`);
    expect(row).toHaveLength(1);
    // The whole justification for storing them (D71): a citation naming p.7 can be opened at p.7
    // only if what comes back is the file that went in.
    expect(Buffer.compare(row[0]!.bytes, Buffer.from(original))).toBe(0);
    expect(row[0]!.sha256).toBe(r.sha256);
    expect(Number(row[0]!.byte_len)).toBe(original.byteLength);
  }, 180_000);

  it('records the extractor version, so re-chunking knows what produced the text', async () => {
    const r = await importFile(ctxA(), { bytes: bytes('sample.docx'), filename: 'sample.docx', slug: `ext-docx-${RUN}` });
    const row = await withScopedTx(ctxA(), (tx) => tx<{ extractor: string; extracted_text: string; body: string | null }[]>`
      select extractor, extracted_text, body from pages where id = ${r.pageId}`);
    expect(row[0]!.extractor).toMatch(/^mammoth@\d/);
    expect(row[0]!.extracted_text.length).toBeGreaterThan(0);
    // `body` stays NULL for a file-sourced page — 0009's column comment says so, and the two columns
    // carry different semantics (authored vs derived).
    expect(row[0]!.body).toBeNull();
  }, 180_000);

  it('a byte-identical re-upload is refused, not silently duplicated', async () => {
    const b = bytes('sample.csv');
    await importFile(ctxA(), { bytes: b, filename: 'sample.csv', slug: `dup-one-${RUN}` });
    const err = await importFile(ctxA(), { bytes: b, filename: 'copy.csv', slug: `dup-two-${RUN}` }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OperationError);
    expect((err as OperationError).code).toBe('already_exists');
    // Deliberately does NOT name the colliding page — that would reopen the enumeration oracle D73
    // closed on exactly this index.
    expect((err as OperationError).message).not.toMatch(new RegExp(`dup-one-${RUN}`));
  }, 180_000);

  it('the same file may be BOTH a shared page and a private one — the sha indexes are partial', async () => {
    // The pre-embed duplicate check must mirror the partial unique indexes, not be stricter than
    // them. 0007 (slug) and 0009 (sha256) are both partial on `scope`, and the private index is
    // additionally per-author, so this pair is legal by design: a private upload must not be
    // constrained by a shared page the uploader may not even be able to see. A cheap dedup check
    // that ignored scope refused this — quietly undoing D68/D73 in the name of saving an embed.
    const b = bytes('sample.html');
    const shared = await importFile(ctxA(), {
      bytes: b, filename: 'both.html', slug: `both-shared-${RUN}`, scope: 'workspace',
    });
    const priv = await importFile(ctxA(), {
      bytes: b, filename: 'both.html', slug: `both-private-${RUN}`, scope: 'private',
    });
    expect(shared.sha256).toBe(priv.sha256);
    expect(priv.pageId).not.toBe(shared.pageId);

    // …and a SECOND private copy by the same author is still refused, because that IS the index.
    const err = await importFile(ctxA(), {
      bytes: b, filename: 'both.html', slug: `both-private-2-${RUN}`, scope: 'private',
    }).then(() => null, (e: unknown) => e);
    expect((err as OperationError)?.code).toBe('already_exists');
  }, 180_000);

  it('quarantines a rejected upload with the acl the caller ASKED for, then refuses it', async () => {
    // A private upload that fails the sanity gate must stay private in rejection — its FILENAME is
    // as sensitive as the file (D72).
    // One 3,000-character run with no whitespace — the `no_word_boundaries` case, which is what a
    // pasted base64 blob or a minified bundle actually looks like. An earlier fixture here used
    // punctuation, which correctly PASSED the gate: it is printable, long enough, and well under the
    // token cap, so the gate was right and the fixture was wrong.
    const junk = new Uint8Array(Buffer.from('A'.repeat(3000), 'utf8'));
    const err = await importFile(ctxA(), {
      bytes: junk,
      filename: `secret-termination-letter-${RUN}.txt`,
      slug: `junk-${RUN}`,
      scope: 'private',
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(OperationError);
    expect((err as OperationError).code).toBe('extraction_failed');

    // The author can inspect their own rejection…
    const mine = await withScopedTx(ctxA(), (tx) => tx<{ filename: string; reason: string }[]>`
      select filename, reason from quarantine where filename = ${`secret-termination-letter-${RUN}.txt`}`);
    expect(mine, 'the rejection was not recorded — a false reject would be unrecoverable').toHaveLength(1);
    // …and a colleague cannot even see the name of it.
    const theirs = await withScopedTx(ctxB(), (tx) => tx<{ filename: string }[]>`
      select filename from quarantine where filename = ${`secret-termination-letter-${RUN}.txt`}`);
    expect(theirs).toHaveLength(0);
  }, 180_000);

  it('a private file hides its bytes AND its text from a colleague', async () => {
    const r = await importFile(ctxA(), {
      bytes: bytes('sample.pdf'),
      filename: 'confidential.pdf',
      slug: `private-pdf-${RUN}`,
      scope: 'private',
    });
    for (const [table, sql] of [
      ['pages', 'pages'],
      ['page_sources', 'page_sources'],
    ] as const) {
      const rows = await withScopedTx(ctxB(), (tx) =>
        tx.unsafe(`select 1 from ${sql} where ${table === 'pages' ? 'id' : 'page_id'} = $1`, [r.pageId]));
      expect(rows.length, `${table} leaked a private upload to a colleague`).toBe(0);
    }
    const chunks = await withScopedTx(ctxB(), (tx) =>
      tx<{ id: string }[]>`select id from content_chunks where page_id = ${r.pageId}`);
    expect(chunks).toHaveLength(0);
  }, 180_000);

  it('rejects an unsupported format with a remediation, never a 500', async () => {
    const err = await importFile(ctxA(), { bytes: bytes('sample.bin'), filename: 'old.doc', slug: `bad-${RUN}` }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OperationError);
    expect((err as OperationError).code).toBe('unsupported_format');
    expect((err as OperationError).suggestion).toMatch(/Save As/i);
  }, 120_000);
});

// ── The rule the op exists to enforce, asserted without a database ──────────
describe('the ingest_file op takes BYTES, never a path', () => {
  it('declares no path-like parameter', () => {
    // /api/_ops is unauthenticated (D53) and any `member` can call this op, so a path parameter
    // would be a request for the server to read its own filesystem — `{"path":"/proc/self/environ"}`
    // would ingest OPENAI_API_KEY and DATABASE_URL into a page that `ask` then reads back.
    //
    // Asserted over the SCHEMA rather than by trying an exploit: the schema is the contract agents
    // read, and a path parameter added later would pass any behavioural test that only sends bytes.
    const op = operationsByName.ingest_file;
    expect(op, 'the ingest_file op is not registered').toBeDefined();
    const keys = Object.keys(op!.params.shape);
    expect(keys).toContain('content_base64');
    for (const forbidden of ['path', 'file', 'filepath', 'file_path', 'url', 'uri', 'src']) {
      expect(keys, `ingest_file must not accept "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it('is published to agents with the bytes-only contract stated', () => {
    const op = operationsByName.ingest_file!;
    expect(op.description).toMatch(/base64/i);
    expect(op.mutating).toBe(true);
  });
});
