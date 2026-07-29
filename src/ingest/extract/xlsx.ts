// XLSX / spreadsheet -> Block[], one `row` block per record, each carrying its header.
//
// This is the format where naive extraction fails hardest and most quietly. Flattening a sheet to
// prose and splitting every 300 words produces chunks like "Robot arm 3 123456 45123 Gripper 2 …" —
// no column names, no row boundaries, unretrievable. A row that keeps its header is a sentence a
// model can read: "Item: Robot arm | Qty: 3 | Rate: ₹1,23,456.00 | Date: 2026-03-12".
//
// Six things below are each a silent-corruption class, meaning: the file ingests, reports success,
// and the data is simply never findable afterwards.
//
// The sixth was found after this file shipped, and is worse than the other five: a dropped EMPTY
// cell does not make data unfindable, it makes the WRONG data findable under the right column name.
// See joinRow in ../blocks.ts. The lesson worth carrying: the other five were all about cells whose
// value was missing, and the class nobody looked for was the cell whose value was legitimately blank.
import * as XLSX from 'xlsx';
import type { Block, Extracted } from '../blocks.ts';
import { joinRow } from '../blocks.ts';

/** Enforced DURING extraction, not after. A 100k-row export builds >1GB of SheetJS cell objects
 *  before any downstream chunk cap could look at it, so the cap has to bound the read itself. */
const MAX_ROWS_PER_SHEET = 5_000;
const MAX_SHEETS = 50;

/** Total cells expandMerges may materialise per sheet, and the widest single merge it will fill.
 *  A declared merge range is attacker-controlled metadata, not a measurement of the file. */
const MAX_MERGE_CELLS = 200_000;
const MAX_MERGE_COLS = 256;

interface Cell {
  v?: unknown;
  t?: string;
  f?: string;
  w?: string;
}

/** SILENT-CORRUPTION CLASS 1 — merged cells.
 *  SheetJS stores a merged value ONLY in the top-left cell; every other cell in the range is absent.
 *  A header merged across A1:C1 therefore reads `Line items | | |` and the columns beneath it lose
 *  their names. Real invoices and statements are full of merges. */
function expandMerges(ws: XLSX.WorkSheet, lastRow: number): void {
  const merges = ws['!merges'] as XLSX.Range[] | undefined;
  if (!merges) return;

  // CLAMPED, and this is a resource bound rather than a correctness detail. Expansion writes a cell
  // object per covered cell, and a merge range is whatever the file's XML declares — not what the
  // file actually contains. `A1:XFD1048576` costs a few bytes on disk and would be ~17 BILLION
  // object writes here. MAX_ROWS_PER_SHEET exists to bound exactly this kind of read, but this ran
  // above it and outside it; the two limits now agree, and MAX_MERGE_CELLS bounds the total so a
  // few thousand narrow-but-tall merges cannot add up to the same thing.
  let budget = MAX_MERGE_CELLS;
  for (const m of merges) {
    if (budget <= 0) break;
    if (m.s.r > lastRow) continue; // entirely below the row cap — nothing readable comes from it
    const anchor = ws[XLSX.utils.encode_cell({ r: m.s.r, c: m.s.c })] as Cell | undefined;
    if (!anchor) continue;
    const endRow = Math.min(m.e.r, lastRow);
    const endCol = Math.min(m.e.c, m.s.c + MAX_MERGE_COLS - 1);
    for (let r = m.s.r; r <= endRow && budget > 0; r++) {
      for (let c = m.s.c; c <= endCol && budget > 0; c++) {
        if (r === m.s.r && c === m.s.c) continue;
        ws[XLSX.utils.encode_cell({ r, c })] = { ...anchor };
        budget--;
      }
    }
  }
}

/** SILENT-CORRUPTION CLASSES 2 AND 3 — dates and formulas.
 *
 *  Dates: without `cellDates` a date is the serial `45123`, so "the invoice dated 12 March 2026"
 *  never matches anything, forever, with no error. Both forms are emitted because the ISO form is
 *  unambiguous and the displayed form is what the user will search for.
 *
 *  Formulas: SheetJS has no formula engine. It returns whatever value the WRITER cached. Files from
 *  server-side generators routinely carry `f` with no `v`, so a computed sheet extracts as blank and
 *  reports success. `undefined` here means the caller counts the row as skipped. */
function cellText(cell: Cell | undefined): string | undefined {
  if (!cell) return '';
  if (cell.v === undefined) {
    return cell.f ? undefined : ''; // formula with no cached value ⇒ genuinely missing
  }
  if (cell.v instanceof Date) {
    const iso = cell.v.toISOString().slice(0, 10);
    const shown = cell.w?.trim();
    return shown && shown !== iso ? `${iso} (${shown})` : iso;
  }
  if (typeof cell.v === 'number') {
    const shown = cell.w?.trim();
    // Keep both: FTS tokenizes "1,23,456.00" badly, and the bare number is the reliable match.
    return shown && shown !== String(cell.v) ? `${cell.v} (${shown})` : String(cell.v);
  }
  return String(cell.v).replace(/\s+/g, ' ').trim();
}

/** SILENT-CORRUPTION CLASS 4 — assuming row 0 is the header.
 *  Real sheets open with a title in A1, a blank row, then headers on row 4. Guessing wrong repeats
 *  `GST Invoice | | |` into every chunk of the sheet, which makes every embedding near-identical and
 *  the whole sheet unretrievable. Heuristic: the first row whose non-empty cells are short and
 *  non-numeric, and whose SUCCESSOR contains at least one number. */
function findHeaderRow(ws: XLSX.WorkSheet, range: XLSX.Range, maxRow: number): number | undefined {
  const rowCells = (r: number): Cell[] => {
    const out: Cell[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })] as Cell | undefined;
      if (cell && cell.v !== undefined) out.push(cell);
    }
    return out;
  };

  for (let r = range.s.r; r <= Math.min(maxRow, range.s.r + 20); r++) {
    const here = rowCells(r);
    if (here.length < 2) continue;
    const allShortText = here.every((c) => typeof c.v === 'string' && String(c.v).trim().length <= 60);
    if (!allShortText) continue;
    const next = rowCells(r + 1);
    if (next.length === 0) continue;
    if (next.some((c) => typeof c.v === 'number' || c.v instanceof Date)) return r;
  }
  return undefined;
}

export function extractXlsx(bytes: Uint8Array): Extracted {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(bytes, { type: 'buffer', cellDates: true, cellNF: true, cellText: true });
  } catch (err) {
    throw new Error(`XLSX_UNREADABLE: ${(err as Error)?.message?.slice(0, 200) ?? ''}`);
  }

  const blocks: Block[] = [];
  const headerRow: Record<string, number> = {};
  let extracted = 0;
  let skipped = 0;

  for (const sheetName of wb.SheetNames.slice(0, MAX_SHEETS)) {
    const ws = wb.Sheets[sheetName];
    if (!ws || !ws['!ref']) continue; // an empty sheet is routine, not a failure — see SKIP_THRESHOLD

    // Range and row cap FIRST, so the merge expansion below is bounded by the same limit that
    // bounds the read. It used to run before this line and was therefore unbounded.
    const range = XLSX.utils.decode_range(ws['!ref']);
    const lastRow = Math.min(range.e.r, range.s.r + MAX_ROWS_PER_SHEET - 1);
    expandMerges(ws, lastRow);

    const hdrIdx = findHeaderRow(ws, range, lastRow);
    let header = '';
    if (hdrIdx !== undefined) {
      headerRow[sheetName] = hdrIdx + 1; // 1-based, to match what a human sees in Excel
      const names: string[] = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        names.push(cellText(ws[XLSX.utils.encode_cell({ r: hdrIdx, c })] as Cell | undefined) ?? '');
      }
      header = joinRow(names);
    }

    const firstDataRow = hdrIdx === undefined ? range.s.r : hdrIdx + 1;
    for (let r = firstDataRow; r <= lastRow; r++) {
      const parts: string[] = [];
      let missing = false;
      for (let c = range.s.c; c <= range.e.c; c++) {
        const t = cellText(ws[XLSX.utils.encode_cell({ r, c })] as Cell | undefined);
        if (t === undefined) {
          // An uncached formula HOLDS ITS COLUMN, so the cells after it stay under their own
          // header names. `skipped` below is what records that its value was lost; dropping the
          // slot as well would lose the value AND move every later value.
          missing = true;
          parts.push('');
          continue;
        }
        parts.push(t);
      }
      const text = joinRow(parts);
      if (text === '') {
        if (missing) skipped++; // a row that was ALL uncached formulas — genuinely lost
        continue;
      }
      if (missing) skipped++;
      extracted++;

      const from = XLSX.utils.encode_cell({ r, c: range.s.c });
      const to = XLSX.utils.encode_cell({ r, c: range.e.c });
      blocks.push({
        text,
        kind: 'row',
        // Carried separately so the chunker repeats it ONCE per chunk rather than once per row —
        // a 50-column header inlined into every row would be most of the payload.
        header: header || undefined,
        locator: { kind: 'sheet', sheet: sheetName, from, to },
      });
    }

    if (range.e.r > lastRow) {
      skipped += range.e.r - lastRow; // rows past the cap are lost, and must say so
    }
  }

  return {
    format: 'xlsx',
    blocks,
    meta: { sheetNames: wb.SheetNames, headerRow: Object.keys(headerRow).length ? headerRow : undefined },
    unitsExtracted: extracted,
    unitsSkipped: skipped,
  };
}
