// Read-only extraction audit: run a directory of REAL documents through the extractor and print
// what the model would actually be shown.
//
// Why this exists. Every automated test of the extract path runs against eight fixtures this repo
// generated itself, and a generated fixture has the shape its parser expects — which is a tautology,
// not a test. Two silent-corruption criticals have already landed in that gap:
//
//   * a blank spreadsheet cell shifted every column after it, so a row read
//     `Robot arm | 123456 | 2026-03-12` against the header `Item | Qty | Rate | Date`. The model was
//     shown Qty=123456 when 123456 was the Rate, and `ask` answered "the quantity was 123,456" with
//     a correct-looking citation. No error, no `degraded` flag, no trace.
//   * a wide sheet produced chunks at 2.3x the token cap and landed as an untyped 500.
//
// Neither was findable by a suite, because nothing FAILED. That is the whole point: this script
// cannot assert correctness for you. It exists to put the extracted text in front of a human
// cheaply, because reading it is the only check that catches this class.
//
// Touches no database, writes nothing, and sends nothing to a provider — extraction only.
//
//   bun run scripts/extract-audit.ts ~/Desktop/some-folder
//   bun run scripts/extract-audit.ts ~/Desktop/some-folder --full   # whole text, not a head
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { extractFile } from '../src/ingest/extract/index.ts';
import { assessExtraction } from '../src/ingest/sanity.ts';
import { ACCEPTED_EXTENSIONS } from '../src/ingest/extract/detect.ts';

const MAX_FILE_BYTES = 25 * 1024 * 1024; // mirrors importFile's cap; larger files are refused there
const PREVIEW_CHARS = 1200;

const IGNORED_DIRS = new Set(['node_modules', '.git', '.svn', '__MACOSX', 'dist', 'build', '.next', 'vendor']);

/** Machine-generated files that are technically supported formats and carry no knowledge. A
 *  package-lock.json ingests as ~35,000 characters of `/packages/node_modules~1@alloc~1quick-lru/
 *  version: 5.2.0` — real cost in embeddings and real noise in retrieval, for a file no one will
 *  ever ask a question about. Found by auditing a real repo, where it landed as "clean". */
const IGNORED_FILES = new Set([
  'package-lock.json',
  'bun.lock',
  'bun.lockb',
  'yarn.lock',
  'pnpm-lock.yaml',
  'composer.lock',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'Gemfile.lock',
  'go.sum',
  'tsconfig.tsbuildinfo',
]);

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name.startsWith('._')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!IGNORED_DIRS.has(e.name)) await walk(p, out);
    } else if (
      !IGNORED_FILES.has(e.name) &&
      (ACCEPTED_EXTENSIONS as readonly string[]).includes(extname(e.name).toLowerCase())
    ) {
      out.push(p);
    }
  }
  return out;
}

const dir = process.argv[2];
const full = process.argv.includes('--full');
if (!dir) {
  console.error('usage: bun run scripts/extract-audit.ts <directory> [--full]');
  process.exit(2);
}

const files = (await walk(dir)).sort();
if (files.length === 0) {
  console.error(`no supported files under ${dir} (looking for ${ACCEPTED_EXTENSIONS.join(', ')})`);
  process.exit(2);
}
console.error(`Auditing ${files.length} file(s) under ${dir}\n`);

let clean = 0;
let degraded = 0;
let failed = 0;
const worry: string[] = [];

for (const path of files) {
  const name = basename(path);
  const size = (await stat(path)).size;
  if (size > MAX_FILE_BYTES) {
    // Both numbers derived, never written out. A hardcoded "5 MB" in this line survived the cap
    // going to 25 MB and told the user something false — the same drift the repo's body-limit tests
    // exist to catch on the UI side.
    console.log(
      `\n${'='.repeat(78)}\n${name}\n  SKIPPED — ${(size / 1024 / 1024).toFixed(1)} MB is over the ` +
        `${MAX_FILE_BYTES / 1024 / 1024} MB ingest cap`,
    );
    continue;
  }

  try {
    const bytes = new Uint8Array(await readFile(path));
    const ex = await extractFile(bytes, name);
    const text = ex.blocks.map((b) => b.text).join('\n');
    const sanity = assessExtraction(ex);

    console.log(`\n${'='.repeat(78)}`);
    console.log(name);
    console.log(
      `  format=${ex.format} via ${ex.extractor}  blocks=${ex.blocks.length}  chars=${text.length}` +
        (ex.title ? `\n  embedded title: ${JSON.stringify(ex.title)}` : '') +
        (Object.keys(ex.meta).length > 0 ? `\n  meta: ${JSON.stringify(ex.meta)}` : '') +
        (sanity.ok
          ? sanity.degraded
            ? '\n  DEGRADED — some content was lost on the way in'
            : ''
          : `\n  SANITY-REJECTED (${sanity.reason}): ${sanity.detail}`),
    );
    console.log('-'.repeat(78));
    console.log(
      full ? text : text.slice(0, PREVIEW_CHARS) + (text.length > PREVIEW_CHARS ? '\n… (--full for the rest)' : ''),
    );

    if (!sanity.ok) {
      failed++;
      worry.push(`${name}: sanity rejected — ${sanity.detail}`);
    } else if (sanity.degraded) {
      degraded++;
      worry.push(`${name}: degraded — content was lost; read this one closely`);
    } else {
      clean++;
    }
  } catch (e) {
    failed++;
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`\n${'='.repeat(78)}\n${name}\n  THREW: ${msg}`);
    worry.push(`${name}: threw — ${msg}`);
  }
}

console.error(`\n${'='.repeat(78)}`);
console.error(`${clean} clean · ${degraded} partial · ${failed} failed of ${files.length}`);
if (worry.length > 0) {
  console.error('\nWorth a closer look:');
  for (const w of worry) console.error(`  - ${w}`);
}
// The counts are the cheap half. The expensive half is you reading the text above and checking it
// says what the document says — a column shifted one place left is CLEAN by every count here.
console.error(
  '\nThe counts above cannot see the failure mode this exists for. Read the text: a spreadsheet\n' +
    'column shifted one place left, or a two-column PDF interleaved, counts as CLEAN here.',
);
