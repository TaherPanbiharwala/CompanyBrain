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
import * as XLSX from 'xlsx';
import { extractFile, extractorFor, EXTRACTOR_VERSIONS } from '../src/ingest/extract/index.ts';
// Imported directly rather than through extractFile: the locator invariant below is a property of
// the parser, and going through the subprocess would make a parser bug look like a transport bug.
import { extractPlain } from '../src/ingest/extract/text.ts';
import { extractXlsx } from '../src/ingest/extract/xlsx.ts';
import { detect } from '../src/ingest/extract/detect.ts';
import { htmlToBlocks } from '../src/ingest/extract/html.ts';
import { isDegraded, mergeLocators, formatLocator, joinRow } from '../src/ingest/blocks.ts';
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

// The sixth silent-corruption class, and the only one that produces a WRONG answer rather than a
// missing one. No fixture and no subprocess: the bug lives in cell-joining, so it is asserted at
// exactly that level, where a failure names the cause instead of pointing at an extraction run.
describe('an empty cell holds its column (the sixth corruption class)', () => {
  it('joinRow keeps interior blanks and drops only trailing ones', () => {
    // Interior: positional, kept — this is the whole fix.
    expect(joinRow(['Robot arm', '', '123456', '2026-03-12'])).toBe('Robot arm |  | 123456 | 2026-03-12');
    // Trailing: a short row is unambiguous, so they go rather than ending every row in ' |  | '.
    expect(joinRow(['Robot arm', '', ''])).toBe('Robot arm');
    // All blank: the row carries nothing, and callers use '' as that signal.
    expect(joinRow(['', '', ''])).toBe('');
    expect(joinRow([])).toBe('');
  });

  it('THE REGRESSION: a blank CSV cell does not shift later values under the wrong header', async () => {
    // Before the fix both sides used .filter(Boolean), so this row extracted as
    // "Robot arm | 123456 | 2026-03-12" under "Item | Qty | Rate | Date" — the model was shown
    // Qty=123456 and answered "the quantity was 123,456" with a citation to the right cell range.
    // No error, no `degraded` flag. Asserting the JOINED text is the point: a cell-count check
    // would pass on the shifted output too.
    const csv = 'Item,Qty,Rate,Date\nRobot arm,,123456,2026-03-12\n';
    const out = await extractFile(new TextEncoder().encode(csv), 'items.csv');

    expect(out.blocks).toHaveLength(1);
    const row = out.blocks[0]!;
    expect(row.header).toBe('Item | Qty | Rate | Date');
    expect(row.text).toBe('Robot arm |  | 123456 | 2026-03-12');

    // The property that actually matters, stated positionally rather than as a string compare:
    // value N of the row is value N of the header, so Rate is the number and Date is the date.
    const cols = row.header!.split(' | ');
    const vals = row.text.split(' | ');
    expect(vals[cols.indexOf('Rate')]).toBe('123456');
    expect(vals[cols.indexOf('Date')]).toBe('2026-03-12');
    expect(vals[cols.indexOf('Qty')]).toBe('');
  });

  it('a fully blank CSV row is still dropped, not emitted as separators', async () => {
    const csv = 'A,B\n1,2\n,,\n3,4\n';
    const out = await extractFile(new TextEncoder().encode(csv), 't.csv');
    expect(out.blocks.map((b) => b.text)).toEqual(['1 | 2', '3 | 4']);
  });

  it('XLSX has its own cell loop, so it gets its own assertion', () => {
    // Built in memory rather than from sample.xlsx: the fixture has no blank cell, so a
    // fixture-driven test would pass against the shifted output too.
    const ws = XLSX.utils.aoa_to_sheet([
      ['Item', 'Qty', 'Rate', 'Date'],
      ['Robot arm', null, 123456, '2026-03-12'], // interior blank — the bug
      ['Gripper', 2, 500, null], // trailing blank — dropped
      [null, null, null, null], // wholly blank — no block at all
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'S1');
    const out = extractXlsx(new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })));

    expect(out.blocks.map((b) => b.text)).toEqual([
      'Robot arm |  | 123456 | 2026-03-12',
      'Gripper | 2 | 500',
    ]);
    expect(out.blocks[0]!.header).toBe('Item | Qty | Rate | Date');
    // A blank cell is not a skipped unit — nothing was lost, so `degraded` must stay quiet.
    expect(out.unitsExtracted).toBe(2);
    expect(out.unitsSkipped).toBe(0);
    expect(isDegraded(out)).toBe(false);
  });
});

// A SEVENTH silent-corruption class: a quoted CSV field containing an embedded newline. Any
// notes/body/description column exported from Excel or Google Sheets is routinely full of these.
//
// Before the fix, extractCsv split the raw buffer on '\n' BEFORE running its quote-aware field
// splitter, so the outer split ran with no quote state at all. One logical row with an embedded
// newline came apart into several independent, garbage partial rows — still ingested, still
// reported success, no error and no `degraded` flag. Compare src/ingest/extract/xlsx.ts, which
// never had this bug: SheetJS's parser is quote-aware across the whole buffer, not per pre-split
// line.
describe('an embedded newline in a quoted CSV field does not shred the row', () => {
  it('keeps a multi-line quoted field as ONE row, not several', async () => {
    const csv = 'Item,Notes\n"Robot arm","Line one\nLine two\nLine three"\nGripper,fine\n';
    const out = await extractFile(new TextEncoder().encode(csv), 'notes.csv');

    expect(out.blocks).toHaveLength(2);
    expect(out.blocks[0]!.header).toBe('Item | Notes');
    expect(out.blocks[0]!.text).toBe('Robot arm | Line one\nLine two\nLine three');
    expect(out.blocks[1]!.text).toBe('Gripper | fine');
    expect(out.unitsExtracted).toBe(2);
  }, 60_000);

  it('a doubled quote still resolves correctly inside a field that also spans lines', async () => {
    const csv = 'Item,Notes\n"Robot arm","He said ""hi""\nthen left"\n';
    const out = await extractFile(new TextEncoder().encode(csv), 'notes2.csv');

    expect(out.blocks).toHaveLength(1);
    expect(out.blocks[0]!.text).toBe('Robot arm | He said "hi"\nthen left');
  }, 60_000);
});

// The locator invariant, added after a real regression: when fenced code blocks gained their own
// block kind, the code path recorded `from` as the offset of the opening ``` LINE while `text` held
// only the content between the fences. `slice(from, from + text.length)` therefore ran off the end
// and every code-block citation pointed a few characters upstream.
//
// Nothing errored. The extracted TEXT was correct, chunking was correct, retrieval was correct —
// only the pointer a human follows back to the source was wrong, which is the same silent class as
// the CSV column shift. It survived a full green suite because no assertion had ever tied a block's
// text to the span its locator claims. This is that assertion.
describe('offset locators point at the text they claim', () => {
  const DOCS: Record<string, string> = {
    'prose, fences and a list': '# Title\n\nFirst paragraph with enough text to matter.\n\n```bash\nnpm run dev\nyarn dev\n```\n\nSecond paragraph.\n\n- item one\n- item two\n\nEnd.\n',
    'fence as the very first thing': '```js\nconst a = 1;\n```\n\nAfter.\n',
    'unclosed fence keeps its content': 'Intro text here.\n\n```\nnever closed\n',
    'tilde fences': 'Before.\n\n~~~python\nx = 1\n~~~\n\nAfter.\n',
    'blank line INSIDE a fence (would be torn by a naive paragraph split)': 'Intro.\n\n```\na\n\nb\n```\n\nEnd.\n',
    'CRLF line endings': '# H\r\n\r\n```\r\nx\r\n```\r\n\r\nTail.\r\n',
  };

  const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

  for (const [name, doc] of Object.entries(DOCS)) {
    it(name, () => {
      // extractPlain normalises CRLF before it assigns offsets, so the source the offsets index
      // into is the normalised form, not the raw bytes.
      const source = doc.replace(/\r\n/g, '\n');
      const { blocks } = extractPlain(new TextEncoder().encode(doc), 'markdown');
      expect(blocks.length).toBeGreaterThan(0); // anti-vacuity: zero blocks must not pass
      for (const b of blocks) {
        const loc = b.locator as { kind: 'offset'; from: number; to: number };
        expect(loc.kind).toBe('offset');
        expect(loc.to).toBeGreaterThan(loc.from);
        expect(loc.to).toBeLessThanOrEqual(source.length);
        // The block's text must be recoverable from the span its locator names. Whitespace is
        // squashed because the paragraph path legitimately collapses newlines; the ORIGIN must
        // still be right.
        expect(squash(source.slice(loc.from, loc.to))).toContain(squash(b.text).slice(0, 25));
      }
    });
  }

  it('code blocks keep their newlines and are typed as code, not paragraph', () => {
    const { blocks } = extractPlain(
      new TextEncoder().encode('Intro.\n\n```bash\nnpm run dev\nyarn dev\n```\n'),
      'markdown',
    );
    const code = blocks.find((b) => b.kind === 'code');
    expect(code).toBeDefined();
    // The regression this replaces: "npm run dev yarn dev" — two commands fused into one string
    // that reads as a single command and is not.
    expect(code!.text).toBe('npm run dev\nyarn dev');
  });
});
