// Plain text, Markdown, CSV and JSON — the formats that need no library.
//
// NOTE, deliberately: `extractText` performs NO speaker detection. A `^Name:` rule would also match
// `Note:`, `TODO:`, `Warning:` and `10:30:`, and test/fixtures/a17-corpus/2026-06-03-standup-notes.md
// contains lines shaped exactly like that (`PN: rate limiter on the fleet API …`). Adding the rule
// would silently re-chunk an existing fixture and move the retrieval baseline before anything had
// been measured. Conversation structure comes from formats that declare it, not from guessing.
import type { Block, Extracted } from '../blocks.ts';
import { htmlToBlocks, htmlTitle } from './html.ts';

const decode = (b: Uint8Array): string => new TextDecoder('utf-8', { fatal: false }).decode(b);

/** ATX (`# x`) and setext (`x\n===`) headings; everything else is a paragraph or a list item.
 *  Character offsets are the only locator plain text can honestly supply. */
export function extractPlain(bytes: Uint8Array, format: 'text' | 'markdown'): Extracted {
  const raw = decode(bytes).replace(/\r\n/g, '\n');
  const blocks: Block[] = [];
  let offset = 0;

  for (const para of raw.split(/\n{2,}/)) {
    const start = raw.indexOf(para, offset);
    const from = start >= 0 ? start : offset;
    const to = from + para.length;
    offset = to;

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

  const header = splitLine(lines[0]!).filter(Boolean).join(' | ');
  const blocks: Block[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]!).filter(Boolean);
    if (cells.length === 0) continue;
    blocks.push({ text: cells.join(' | '), kind: 'row', header: header || undefined });
  }

  return {
    format: 'csv',
    blocks,
    meta: { headerRow: header ? { csv: 1 } : undefined },
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
