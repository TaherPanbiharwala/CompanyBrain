// The extraction contract. Every format converges here, and everything downstream depends only on
// this shape — not on which library produced it.
//
// The design decision that makes multi-format work: extractors return STRUCTURE, not a blob of text.
// A spreadsheet flattened to prose and split every 300 words is unusable; a row that keeps its header
// is retrievable. A PDF page that knows it is page 7 produces a citation a human can check. Both
// follow from emitting blocks instead of a string.

export type BlockKind =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'table' // a whole small table, or a header row that must ride along with its rows
  | 'row' // one spreadsheet/CSV record — NEVER split mid-row
  | 'code';

/** WHERE a piece of content came from, precisely enough to point a human at it.
 *
 *  Every form is a SPAN, not a point, and that is not over-engineering: chunks are packed from
 *  multiple blocks with overlap, so a chunk routinely covers pages 7-8 or rows 40-60. A `{page: 7}`
 *  point form cannot express that, and "the citation names page 7" is the entire reason the original
 *  file is retained. The chunker's merge rule is min/max across the blocks it packed. */
export type Locator =
  | { kind: 'page'; from: number; to: number }
  | { kind: 'sheet'; sheet: string; from: string; to: string } // A1-style cell refs
  | { kind: 'path'; pointer: string } // RFC-6901 JSON pointer
  | { kind: 'offset'; from: number; to: number }; // character offsets, for plain text

export interface Block {
  text: string;
  kind: BlockKind;
  /** Heading depth, 1-6. Only meaningful for `heading`. */
  level?: number;
  locator?: Locator;
  /** For `row` blocks: the header line that must be repeated into any chunk containing this row.
   *  Carried separately from `text` so the chunker can repeat it per chunk without duplicating it
   *  per row — a 50-column header repeated into every row would be most of the payload. */
  header?: string;
}

export type ExtractFormat = 'pdf' | 'docx' | 'xlsx' | 'csv' | 'json' | 'html' | 'markdown' | 'text';

export interface Extracted {
  format: ExtractFormat;
  /** From document metadata when the format carries it (PDF Info, docx title). Never invented. */
  title?: string;
  blocks: Block[];
  /** Structural facts only. Deliberately NOT author/creator/lastModifiedBy: those name a third party
   *  who never agreed to be in this database, in a product whose pitch is data discipline, in a
   *  column nothing reads. `headerRow` is here so a wrong header guess is debuggable rather than
   *  mysterious. */
  meta: {
    pageCount?: number;
    sheetNames?: string[];
    headerRow?: Record<string, number>;
    attachments?: string[];
  };
  /** Pages / sheets / records that yielded text. */
  unitsExtracted: number;
  /** Units that yielded NOTHING — a scanned PDF page, a formula cell with no cached value, an
   *  attachment we did not open. Load-bearing: a 40-page PDF where 37 pages are scans must not
   *  report the same shape as a clean 3-page extraction. */
  unitsSkipped: number;
}

/** What counts as "mostly failed", per format.
 *
 *  A single ratio across all formats is wrong in both directions: an empty template sheet in a
 *  workbook is routine and says nothing about quality, while a PDF page with no text layer is
 *  exactly the failure worth shouting about. */
export const SKIP_THRESHOLD: Record<ExtractFormat, number> = {
  pdf: 0.3,
  docx: 0.5,
  xlsx: 0.8, // template/lookup sheets are normal; only a near-total miss is interesting
  csv: 0.5,
  json: 0.5,
  html: 0.5,
  markdown: 0.5,
  text: 0.5,
};

export function isDegraded(e: Extracted): boolean {
  const total = e.unitsExtracted + e.unitsSkipped;
  if (total === 0) return true;
  return e.unitsSkipped / total > SKIP_THRESHOLD[e.format];
}

/** Merge a set of block locators into the one span a chunk should carry. Returns undefined when the
 *  blocks disagree about kind or sheet — a chunk spanning two sheets has no honest single locator,
 *  and inventing one would put a wrong reference under a citation. */
export function mergeLocators(locs: (Locator | undefined)[]): Locator | undefined {
  const present = locs.filter((l): l is Locator => l !== undefined);
  if (present.length === 0) return undefined;
  const first = present[0]!;
  if (!present.every((l) => l.kind === first.kind)) return undefined;

  switch (first.kind) {
    case 'page': {
      const ps = present as Extract<Locator, { kind: 'page' }>[];
      return { kind: 'page', from: Math.min(...ps.map((p) => p.from)), to: Math.max(...ps.map((p) => p.to)) };
    }
    case 'offset': {
      const os = present as Extract<Locator, { kind: 'offset' }>[];
      return { kind: 'offset', from: Math.min(...os.map((o) => o.from)), to: Math.max(...os.map((o) => o.to)) };
    }
    case 'sheet': {
      const ss = present as Extract<Locator, { kind: 'sheet' }>[];
      if (!ss.every((s) => s.sheet === ss[0]!.sheet)) return undefined;
      // Cell refs are already row-ordered within a sheet, so first/last is the span.
      return { kind: 'sheet', sheet: ss[0]!.sheet, from: ss[0]!.from, to: ss[ss.length - 1]!.to };
    }
    case 'path':
      // Pointers do not span meaningfully — keep the first, which is the chunk's entry point.
      return first;
  }
}

/** Human-facing form, for citations. Kept next to the type so the two cannot drift. */
export function formatLocator(l: Locator | undefined): string | undefined {
  if (!l) return undefined;
  switch (l.kind) {
    case 'page':
      return l.from === l.to ? `p.${l.from}` : `pp.${l.from}-${l.to}`;
    case 'sheet':
      return l.from === l.to ? `${l.sheet}!${l.from}` : `${l.sheet}!${l.from}:${l.to}`;
    case 'path':
      return l.pointer;
    case 'offset':
      return `chars ${l.from}-${l.to}`;
  }
}
