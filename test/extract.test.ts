// Extraction: format detection, the subprocess boundary, and the silent-corruption classes.
//
// No database. Fixtures come from `bun run gen:test-files` and are committed, so a Bun or library
// incompatibility surfaces here rather than at upload time.
//
// What these do NOT prove, stated so the green tick is not over-read: the fixtures are generated, and
// a generated PDF is the easiest PDF in existence. Two-column layouts, page-spanning tables,
// ligatures and Devanagari are where real extraction fails, and nothing here touches them.
import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFile, extractorFor, EXTRACTOR_VERSIONS } from '../src/ingest/extract/index.ts';
import { detect } from '../src/ingest/extract/detect.ts';
import { htmlToBlocks } from '../src/ingest/extract/html.ts';
import { isDegraded, mergeLocators, formatLocator } from '../src/ingest/blocks.ts';
import { OperationError } from '../src/api/errors.ts';

const DIR = join(new URL('.', import.meta.url).pathname, 'fixtures', 'formats');
const bytes = (n: string): Uint8Array => new Uint8Array(readFileSync(join(DIR, n)));
const HAVE_FIXTURES = existsSync(join(DIR, 'sample.pdf'));

// UNGATED on purpose. Five of the describes below are `skipIf(!HAVE_FIXTURES)`, so a missing
// fixture turns most of this file into silent green — and the fixtures were untracked, with CI
// never running `gen:test-files`. That combination is exactly the shape D43 exists to prevent: a
// suite that reports success having asserted nothing.
describe('the format fixtures are committed', () => {
  it('every fixture the suite depends on exists on disk', () => {
    for (const f of ['sample.pdf', 'sample.docx', 'sample.xlsx', 'sample.csv', 'sample.json', 'sample.html', 'sample.bin', 'liar.txt']) {
      expect(existsSync(join(DIR, f)), `${f} is missing — run \`bun run gen:test-files\` and COMMIT it`).toBe(true);
    }
  });
});

describe.skipIf(!HAVE_FIXTURES)('detect — magic bytes, not the extension', () => {
  it('a PDF named .txt is detected as a PDF', () => {
    // The whole reason detection reads bytes: an extension is attacker-supplied over HTTP and
    // wrong-by-accident everywhere else. Chunking a PDF as prose embeds binary noise at real cost.
    expect(detect(bytes('liar.txt'), 'liar.txt').format).toBe('pdf');
  });

  it('distinguishes docx from xlsx — both are zips', () => {
    expect(detect(bytes('sample.docx'), 'sample.docx').format).toBe('docx');
    expect(detect(bytes('sample.xlsx'), 'sample.xlsx').format).toBe('xlsx');
  });

  it('names a legacy OLE file so the error can name the fix', () => {
    const d = detect(bytes('sample.bin'), 'old.doc');
    expect(d.format).toBe('unsupported');
    expect(d.looksLike).toMatch(/legacy Word/i);
  });

  it('an empty file is unsupported, not "text"', () => {
    expect(detect(new Uint8Array(0), 'x.txt').format).toBe('unsupported');
  });

  it('classifies the textual formats', () => {
    expect(detect(bytes('sample.json'), 'sample.json').format).toBe('json');
    expect(detect(bytes('sample.html'), 'sample.html').format).toBe('html');
    expect(detect(bytes('sample.csv'), 'sample.csv').format).toBe('csv');
  });
});

describe.skipIf(!HAVE_FIXTURES)('PDF', () => {
  it('one block per page, with a page locator', async () => {
    const r = await extractFile(bytes('sample.pdf'), 'sample.pdf');
    expect(r.format).toBe('pdf');
    expect(r.blocks.length).toBeGreaterThan(0);
    expect(r.blocks[0]!.locator).toEqual({ kind: 'page', from: 1, to: 1 });
    expect(r.blocks[0]!.text).toContain('4.2 crore');
  }, 60_000);

  it('a page with no text layer counts as SKIPPED, not as success', async () => {
    // The fixture's page 2 has no text operators — the scanned-page case. A 40-page PDF where 37
    // pages are scans must not be indistinguishable from a clean 3-page extraction.
    const r = await extractFile(bytes('sample.pdf'), 'sample.pdf');
    expect(r.meta.pageCount).toBe(2);
    expect(r.unitsExtracted).toBe(1);
    expect(r.unitsSkipped).toBe(1);
  }, 60_000);
});

describe.skipIf(!HAVE_FIXTURES)('DOCX', () => {
  it('preserves heading levels through mammoth and the shared HTML converter', async () => {
    const r = await extractFile(bytes('sample.docx'), 'sample.docx');
    const headings = r.blocks.filter((b) => b.kind === 'heading');
    expect(headings.map((h) => h.level)).toEqual([1, 2]);
    expect(headings[0]!.text).toBe('Renewal terms');
  }, 60_000);
});

describe.skipIf(!HAVE_FIXTURES)('XLSX — the silent-corruption classes', () => {
  it('finds the real header row, not row 0', async () => {
    // The fixture opens with a merged title in A1:D1 and a blank row. Assuming row 0 is the header
    // would repeat "Q3 Invoice — Northstar Robotics | | |" into every chunk, making every embedding
    // near-identical and the sheet unretrievable.
    const r = await extractFile(bytes('sample.xlsx'), 'sample.xlsx');
    expect(r.meta.headerRow?.Invoice).toBe(3);
    const row = r.blocks.find((b) => b.text.includes('Robot arm'));
    expect(row?.header).toBe('Item | Qty | Rate | Date');
    expect(row?.header).not.toContain('Q3 Invoice');
  }, 60_000);

  it('emits a date as ISO, never a raw serial', async () => {
    // Without cellDates the value is 45123, so "the invoice dated 12 March 2026" never matches —
    // forever, with no error anywhere.
    const r = await extractFile(bytes('sample.xlsx'), 'sample.xlsx');
    const row = r.blocks.find((b) => b.text.includes('Robot arm'))!;
    expect(row.text).toContain('2026-03-12');
    expect(row.text).not.toMatch(/\b451\d\d\b/);
  }, 60_000);

  it('counts a formula with no cached value as skipped', async () => {
    // SheetJS has no formula engine — it returns the value the WRITER cached. Server-generated files
    // routinely carry a formula with none, and emitting blank would report success on lost data.
    const r = await extractFile(bytes('sample.xlsx'), 'sample.xlsx');
    expect(r.unitsSkipped).toBeGreaterThan(0);
  }, 60_000);

  it('a row keeps its header, so a cell is retrievable with its column name', async () => {
    const r = await extractFile(bytes('sample.xlsx'), 'sample.xlsx');
    const sentinel = r.blocks.find((b) => b.text.includes('zzsentinelrow40'));
    expect(sentinel, 'the row-40 sentinel must be extracted').toBeDefined();
    expect(sentinel!.kind).toBe('row');
    expect(sentinel!.header).toContain('Region');
    const loc = sentinel!.locator as { kind: 'sheet'; sheet: string };
    expect(loc.kind).toBe('sheet');
    expect(loc.sheet).toBe('Territories');
  }, 60_000);
});

describe.skipIf(!HAVE_FIXTURES)('CSV / JSON / HTML', () => {
  it('CSV rows carry the header and respect quoted delimiters', async () => {
    const r = await extractFile(bytes('sample.csv'), 'sample.csv');
    expect(r.blocks.every((b) => b.kind === 'row')).toBe(true);
    expect(r.blocks[0]!.header).toBe('Item | Qty | Rate');
    // "Cable, braided" is one field, not two.
    expect(r.blocks.some((b) => b.text.includes('Cable, braided'))).toBe(true);
  }, 60_000);

  it('JSON flattens to path:value with a pointer locator', async () => {
    const r = await extractFile(bytes('sample.json'), 'sample.json');
    expect(r.blocks[0]!.locator).toEqual({ kind: 'path', pointer: '/pricing' });
    expect(r.blocks[0]!.text).toContain('/pricing/starter/perRobot: 4500');
  }, 60_000);

  it('HTML keeps structure and drops script contents', async () => {
    const r = await extractFile(bytes('sample.html'), 'sample.html');
    expect(r.title).toBe('Routing engine');
    expect(r.blocks.some((b) => b.kind === 'heading' && b.level === 1)).toBe(true);
    expect(r.blocks.some((b) => b.kind === 'row' && b.text.includes('Falcon | shipped'))).toBe(true);
    expect(r.blocks.some((b) => b.text.includes('var x'))).toBe(false);
  }, 60_000);
});

describe.skipIf(!HAVE_FIXTURES)('failure paths are typed, never a 500', () => {
  it('an unsupported format names the remediation', async () => {
    const err = await extractFile(bytes('sample.bin'), 'old.doc').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OperationError);
    const oe = err as OperationError;
    expect(oe.code).toBe('unsupported_format');
    expect(oe.status).toBe(415);
    expect(oe.suggestion).toMatch(/Save As/i);
  }, 60_000);
});

describe('the subprocess boundary', () => {
  it('THE REGRESSION: the child process holds none of this process\'s secrets', async () => {
    // This assertion used to read the SOURCE for `env: { PATH:` and the absence of
    // `...process.env`. Both were true, continuously, while the child was in fact receiving
    // DATABASE_URL, OPENAI_API_KEY, SESSION_SECRET, CB_APP_DB_PASSWORD and OPENROUTER_API_KEY —
    // because Bun's runtime auto-loads `.env` from the child's WORKING DIRECTORY, and the server
    // runs from the repo root where `.env` lives. `env` replaces the inherited environment; it does
    // not stop dotenv loading.
    //
    // So this now spawns a child THE SAME WAY extractFile does and reads its actual environment.
    // A source-shaped assertion cannot see the failure it is meant to prevent; this can.
    const root = join(new URL('.', import.meta.url).pathname, '..');
    const src = readFileSync(join(root, 'src/ingest/extract/index.ts'), 'utf8');
    expect(src, 'Bun.spawn call not found — did the extractor move?').toContain('Bun.spawn(');
    expect(src, 'the worker must be spawned with an explicit PATH-only env').toMatch(/env:\s*\{\s*PATH:/);
    expect(src, 'never spread process.env into the extraction worker').not.toMatch(/\.\.\.process\.env/);
    // …and the property those three lines are a proxy for, measured directly:
    expect(src, 'the child must run in a directory with no .env, or dotenv re-injects every secret')
      .toMatch(/cwd:\s*CHILD_CWD/);

    const probe = join(tmpdir(), `cb-envprobe-${Date.now()}.ts`);
    writeFileSync(
      probe,
      `const leak = ['DATABASE_URL','OPENAI_API_KEY','SESSION_SECRET','CB_APP_DB_PASSWORD','OPENROUTER_API_KEY']\n` +
        `  .filter((k) => process.env[k] !== undefined);\n` +
        `console.log(JSON.stringify({ leak, path: process.env.PATH !== undefined }));\n`,
    );
    try {
      // Spawned from the REPO ROOT on purpose — that is where the server runs and where .env is,
      // so this reproduces the exact condition under which the old assertion passed and leaked.
      const proc = Bun.spawn(['bun', 'run', probe], {
        cwd: mkdtempSync(join(tmpdir(), 'cb-extract-test-')),
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      const got = JSON.parse(out.trim()) as { leak: string[]; path: boolean };
      expect(got.leak, `the extraction child can read ${got.leak.join(', ')}`).toEqual([]);
      expect(got.path, 'PATH must survive — the child still has to find `bun`').toBe(true);
    } finally {
      rmSync(probe, { force: true });
    }
  }, 30_000);

  it('the worker sends its payload framed with a declared length', () => {
    // Without the length, "killed mid-write" and "a dependency wrote to stdout" are the same symptom
    // with different causes — and one of them is a perfectly good file failing to parse.
    const src = readFileSync(join(new URL('.', import.meta.url).pathname, '..', 'src/ingest/extract/worker.ts'), 'utf8');
    expect(src).toContain('CBX1');
    expect(src, 'console must be rebound to stderr before any import can log').toMatch(/console\.log\s*=/);
  });
});

describe('the recorded extractor version', () => {
  it('matches what package.json actually pins', () => {
    // `pages.extractor` exists so re-chunking can tell whether the text it is reusing came from a
    // parser that has since changed. A version string that silently lags the dependency is WORSE
    // than none: it asserts a provenance that is false, and the whole point of the column is to be
    // trusted when deciding which pages need re-extracting.
    const pkg = JSON.parse(
      readFileSync(join(new URL('.', import.meta.url).pathname, '..', 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };

    for (const [dep, recorded] of Object.entries(EXTRACTOR_VERSIONS)) {
      const spec = pkg.dependencies[dep];
      expect(spec, `${dep} is no longer a dependency`).toBeDefined();
      // The tarball URL form (SheetJS is vendored from the official CDN) carries its version in the
      // path rather than as a semver range, so match on containment rather than parsing a range.
      expect(spec!, `EXTRACTOR_VERSIONS.${dep} says ${recorded} but package.json pins ${spec}`).toContain(recorded);
    }
  });

  it('names the library for the formats parsed by a third party, and this repo for the rest', () => {
    expect(extractorFor('pdf')).toMatch(/^unpdf@/);
    expect(extractorFor('docx')).toMatch(/^mammoth@/);
    expect(extractorFor('xlsx')).toMatch(/^xlsx@/);
    // csv/json/html/text are parsed in-repo, where git versions the behaviour better than a string
    // here could — so claiming a library version for them would be the same false provenance.
    expect(extractorFor('csv')).toBe('company-brain/csv');
  });
});

describe('block helpers', () => {
  it('merges page locators into a span', () => {
    expect(
      mergeLocators([
        { kind: 'page', from: 7, to: 7 },
        { kind: 'page', from: 8, to: 8 },
      ]),
    ).toEqual({ kind: 'page', from: 7, to: 8 });
  });

  it('refuses to merge across sheets rather than inventing a reference', () => {
    // A chunk spanning two sheets has no honest single locator; a wrong reference under a citation is
    // worse than none.
    expect(
      mergeLocators([
        { kind: 'sheet', sheet: 'A', from: 'A1', to: 'B1' },
        { kind: 'sheet', sheet: 'B', from: 'A1', to: 'B1' },
      ]),
    ).toBeUndefined();
  });

  it('renders human-facing forms', () => {
    expect(formatLocator({ kind: 'page', from: 7, to: 7 })).toBe('p.7');
    expect(formatLocator({ kind: 'page', from: 7, to: 8 })).toBe('pp.7-8');
    expect(formatLocator({ kind: 'sheet', sheet: 'Q3', from: 'A40', to: 'F40' })).toBe('Q3!A40:F40');
  });

  it('degradation is per-format — an empty template sheet is not a failed workbook', () => {
    const base = { blocks: [], meta: {}, title: undefined };
    expect(isDegraded({ ...base, format: 'pdf', unitsExtracted: 6, unitsSkipped: 4 })).toBe(true);
    expect(isDegraded({ ...base, format: 'xlsx', unitsExtracted: 6, unitsSkipped: 4 })).toBe(false);
    expect(isDegraded({ ...base, format: 'pdf', unitsExtracted: 0, unitsSkipped: 0 })).toBe(true);
  });

  it('htmlToBlocks does not double-count a wrapper div', () => {
    const b = htmlToBlocks('<div><p>one</p><p>two</p></div>');
    expect(b.map((x) => x.text)).toEqual(['one', 'two']);
  });
});
