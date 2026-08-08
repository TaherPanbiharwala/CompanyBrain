// Plain text, Markdown, CSV and JSON — the formats that need no library.
//
// NOTE, deliberately: `extractText` performs NO speaker detection. A `^Name:` rule would also match
// `Note:`, `TODO:`, `Warning:` and `10:30:`, and test/fixtures/a17-corpus/2026-06-03-standup-notes.md
// contains lines shaped exactly like that (`PN: rate limiter on the fleet API …`). Adding the rule
// would silently re-chunk an existing fixture and move the retrieval baseline before anything had
// been measured. Conversation structure comes from formats that declare it, not from guessing.
import type { Block, Extracted } from '../blocks.ts';
import { joinRow } from '../blocks.ts';
import { htmlToBlocks, htmlTitle } from './html.ts';

const decode = (b: Uint8Array): string => new TextDecoder('utf-8', { fatal: false }).decode(b);

/** Carve a markdown document into fenced-code and prose runs, in order, keeping absolute offsets.
 *
 *  Fences must come out BEFORE the blank-line paragraph split, for two independent reasons — either
 *  one alone would be enough:
 *    1. A fence may legally contain a blank line, and the `\n{2,}` split would tear it in half.
 *    2. The paragraph path collapses newlines, and inside a fence they are the content.
 *
 *  Measured on a real corpus before this existed: a three-option shell block came out as
 *  `npm run dev yarn dev pnpm dev` — one string that reads as one command and is not — and a
 *  directory tree came out as a single line. No error, no `degraded` flag, and every count said
 *  clean, which is the signature of the silent-corruption class this codebase has been bitten by
 *  twice already (the CSV column shift and the over-cap chunk). */
function splitFences(raw: string): { code: boolean; text: string; from: number }[] {
  const out: { code: boolean; text: string; from: number }[] = [];
  const lines = raw.split('\n');
  let buf: string[] = [];
  let bufFrom = 0;
  let pos = 0;
  let fence: { marker: string; from: number; lines: string[] } | null = null;

  const flushProse = () => {
    if (buf.length > 0) out.push({ code: false, text: buf.join('\n'), from: bufFrom });
    buf = [];
  };

  for (const line of lines) {
    const lineFrom = pos;
    pos += line.length + 1; // +1 for the '\n' consumed by split

    if (fence) {
      // A closing fence is the same character, at least as long, and carries no info string.
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1]![0] === fence.marker[0] && close[1]!.length >= fence.marker.length) {
        out.push({ code: true, text: fence.lines.join('\n'), from: fence.from });
        fence = null;
      } else {
        fence.lines.push(line);
      }
      continue;
    }

    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open) {
      flushProse();
      // `pos`, not `lineFrom`: pos has already advanced past the opening fence line, so it is the
      // offset of the first CONTENT character. Using lineFrom pointed the locator at the ``` line
      // while `text` held only the content, so `slice(from, from + text.length)` ran off the end and
      // every code-block citation pointed a few characters upstream. Nothing errors when this is
      // wrong — the extracted text is still correct — which is why it needs an assertion, not a
      // reader. See the locator invariant test in test/extract.test.ts.
      fence = { marker: open[1]!, from: pos, lines: [] };
      continue;
    }
    if (buf.length === 0) bufFrom = lineFrom;
    buf.push(line);
  }

  // An UNCLOSED fence keeps its content rather than dropping it. A truncated file is exactly when
  // you most want to see what was there, and silently discarding the tail would be the same class of
  // invisible loss this function exists to fix.
  if (fence) out.push({ code: true, text: fence.lines.join('\n'), from: fence.from });
  flushProse();
  return out;
}

/** ATX (`# x`) and setext (`x\n===`) headings; everything else is a paragraph or a list item.
 *  Character offsets are the only locator plain text can honestly supply. */
export function extractPlain(bytes: Uint8Array, format: 'text' | 'markdown'): Extracted {
  const raw = decode(bytes).replace(/\r\n/g, '\n');
  const blocks: Block[] = [];

  // Only markdown gets fence handling. A .txt file that happens to contain backticks is not
  // claiming they delimit anything, and inventing structure from punctuation would be a guess.
  const segments =
    format === 'markdown' ? splitFences(raw) : [{ code: false, text: raw, from: 0 }];

  for (const seg of segments) {
    if (seg.code) {
      // Trailing whitespace only. Leading indentation is content inside a fence — stripping it is
      // how a YAML or Python block silently stops meaning what it said.
      const code = seg.text.replace(/\s+$/, '');
      if (code.trim()) {
        blocks.push({
          text: code,
          kind: 'code',
          locator: { kind: 'offset', from: seg.from, to: seg.from + seg.text.length },
        });
      }
      continue;
    }

    let offset = 0;
    for (const para of seg.text.split(/\n{2,}/)) {
      const start = seg.text.indexOf(para, offset);
      const rel = start >= 0 ? start : offset;
      offset = rel + para.length;
      const from = seg.from + rel;
      const to = from + para.length;

      const t = para.trim();
      if (!t) continue;
      const loc = { kind: 'offset', from, to } as const;

      const atx = /^(#{1,6})\s+(.*)$/.exec(t);
      if (atx) {
        blocks.push({ text: atx[2]!.trim(), kind: 'heading', level: atx[1]!.length, locator: loc });
        continue;
      }
      const setext = /^(.+)\n(=+|-+)\s*$/.exec(t);
      if (setext) {
        blocks.push({ text: setext[1]!.trim(), kind: 'heading', level: setext[2]![0] === '=' ? 1 : 2, locator: loc });
        continue;
      }
      if (/^\s*([-*+]|\d+\.)\s+/.test(t)) {
        // A run of list items is one block: splitting a list mid-item loses the item's meaning, and
        // items are short enough that the run rarely exceeds a chunk on its own.
        blocks.push({ text: t, kind: 'list', locator: loc });
        continue;
      }
      blocks.push({ text: t.replace(/\n/g, ' '), kind: 'paragraph', locator: loc });
    }
  }

  return {
    format,
    blocks,
    meta: {},
    unitsExtracted: blocks.length > 0 ? 1 : 0,
    unitsSkipped: blocks.length > 0 ? 0 : 1,
  };
}

export function extractHtml(bytes: Uint8Array): Extracted {
  const html = decode(bytes);
  const blocks = htmlToBlocks(html);
  return {
    format: 'html',
    title: htmlTitle(html),
    blocks,
    meta: {},
    unitsExtracted: blocks.length > 0 ? 1 : 0,
    unitsSkipped: blocks.length > 0 ? 0 : 1,
  };
}

/** Column cap for delimited text. Same value and same reasoning as xlsx's MAX_COLS_PER_SHEET —
 *  kept as its own constant because the two extractors share no module, and a shared import here
 *  would make text.ts depend on the xlsx parser it deliberately does not use. */
const MAX_COLS_PER_ROW = 512;

/** CSV/TSV: same shape as a spreadsheet — one `row` block per record, header carried separately. */
export function extractCsv(bytes: Uint8Array): Extracted {
  const raw = decode(bytes).replace(/\r\n/g, '\n').trim();
  const delim = raw.includes('\t') && !raw.slice(0, 2000).includes(',') ? '\t' : ',';

  // Minimal RFC-4180 splitter: quoted fields may contain the delimiter and doubled quotes.
  const splitLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === delim) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };

  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { format: 'csv', blocks: [], meta: {}, unitsExtracted: 0, unitsSkipped: 1 };
  }

  // The COLUMN cap, same constant and same reasoning as xlsx: the header is repeated into every
  // chunk of the file, so an unbounded width is unbounded per-chunk overhead. CSV is the CHEAPER
  // input to abuse — a single line of 200k commas needs no zip container and no spreadsheet at all —
  // so capping only xlsx would have left the easier door open.
  //
  // ONE cap read by the header and the rows alike. If they ever clamp differently, column N of a row
  // stops meaning column N of the header: a silent shift, the same class as the empty-cell bug.
  const clamp = (cells: string[]): string[] => cells.slice(0, MAX_COLS_PER_ROW);
  let colsDropped = 0;

  // joinRow, not `.filter(Boolean).join(' | ')`: an interior empty cell holds its column, or every
  // value after it reads under the wrong header name. See the note on joinRow in blocks.ts.
  const headerCells = splitLine(lines[0]!);
  colsDropped = Math.max(0, headerCells.length - MAX_COLS_PER_ROW);
  const header = joinRow(clamp(headerCells));
  const blocks: Block[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]!);
    colsDropped = Math.max(colsDropped, cells.length - MAX_COLS_PER_ROW);
    const text = joinRow(clamp(cells));
    if (text === '') continue; // every cell blank — the row carries nothing
    blocks.push({ text, kind: 'row', header: header || undefined });
  }

  return {
    format: 'csv',
    blocks,
    meta: {
      headerRow: header ? { csv: 1 } : undefined,
      columnsDropped: colsDropped > 0 ? colsDropped : undefined,
    },
    unitsExtracted: blocks.length,
    unitsSkipped: 0,
  };
}

/** JSON: flattened to `path: value` lines grouped by top-level key.
 *  Chunking a JSON blob by word count produces fragments of syntax; a path-value line is a fact a
 *  model can read and a pointer a human can follow back. */
export function extractJson(bytes: Uint8Array): Extracted {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decode(bytes));
  } catch (err) {
    throw new Error(`JSON_UNREADABLE: ${(err as Error)?.message?.slice(0, 200) ?? ''}`);
  }

  const blocks: Block[] = [];
  const MAX_LINES_PER_GROUP = 400;

  const walk = (node: unknown, pointer: string, lines: string[]): void => {
    if (lines.length >= MAX_LINES_PER_GROUP) return;
    if (node === null || typeof node !== 'object') {
      lines.push(`${pointer || '/'}: ${String(node)}`);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${pointer}/${i}`, lines));
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      // RFC-6901 escaping, so a key containing / or ~ still yields a valid pointer.
      walk(v, `${pointer}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`, lines);
    }
  };

  const top = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? Object.entries(parsed as Record<string, unknown>)
    : [['', parsed] as [string, unknown]];

  for (const [key, value] of top) {
    const lines: string[] = [];
    const pointer = key ? `/${key.replace(/~/g, '~0').replace(/\//g, '~1')}` : '';
    walk(value, pointer, lines);
    if (lines.length === 0) continue;
    blocks.push({
      text: lines.join('\n'),
      kind: 'code',
      locator: { kind: 'path', pointer: pointer || '/' },
    });
  }

  return {
    format: 'json',
    blocks,
    meta: {},
    unitsExtracted: blocks.length,
    unitsSkipped: blocks.length > 0 ? 0 : 1,
  };
}
