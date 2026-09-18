// RAGTest CSV benchmark adapter.
//
// The downloaded dataset is four RFC-4180 CSV files: one corpus and three question files. The
// document text and answers contain embedded newlines and commas, so line-splitting or a naive
// `text.split(',')` silently corrupts both the corpus and the gold mappings.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatasetAdapter, DatasetBundle, EvalDocument, EvalQuestion } from '../types.ts';

const DOCUMENTS_FILE = 'documents.csv';
const SINGLE_FILE = 'single_passage_answer_questions.csv';
const MULTI_FILE = 'multi_passage_answer_questions.csv';
const NO_ANSWER_FILE = 'no_answer_questions.csv';

const ACQUISITION_HINT =
  'Point --dir at the RAGTest directory containing documents.csv, single_passage_answer_questions.csv, ' +
  'multi_passage_answer_questions.csv, and no_answer_questions.csv.';

type CsvRecord = Record<string, string>;

/**
 * Small RFC-4180 parser for the benchmark's four files. Keep this local instead of feeding a CSV
 * through the ingestion extractor: evaluation needs named fields and must retain embedded newline
 * characters in `text` and `answer` rather than rendering rows into a search block.
 */
function parseCsv(path: string, raw: string): CsvRecord[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  // Strip the UTF-8 BOM some spreadsheet exports write before the first header name and normalize
  // CRLF while preserving intentional newlines inside quoted text fields.
  const input = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  for (let index = 0; index < input.length; index++) {
    const ch = input[index]!;
    if (quoted) {
      if (ch === '"' && input[index + 1] === '"') {
        field += '"';
        index++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (field !== '') throw new Error(`${path}: quote appears in the middle of an unquoted field`);
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (quoted) throw new Error(`${path}: unterminated quoted CSV field`);
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length < 2) throw new Error(`${path}: expected a header and at least one data row`);

  const header = rows[0]!.map((name) => name.trim());
  if (header.some((name) => name === '')) throw new Error(`${path}: CSV header contains an empty column name`);
  return rows.slice(1).filter((cells) => cells.some((cell) => cell !== '')).map((cells, index) => {
    if (cells.length !== header.length) {
      throw new Error(`${path}: row ${index + 2} has ${cells.length} columns; expected ${header.length}`);
    }
    return Object.fromEntries(header.map((name, column) => [name, cells[column]!])) as CsvRecord;
  });
}

async function readCsv(root: string, file: string): Promise<CsvRecord[]> {
  const path = join(root, file);
  try {
    return parseCsv(path, await readFile(path, 'utf8'));
  } catch (error) {
    const detail = (error as Error).message;
    throw new Error(`cannot load RAGTest ${file}: ${detail}\n${ACQUISITION_HINT}`);
  }
}

function required(row: CsvRecord, key: string, file: string, rowNumber: number): string {
  const value = row[key];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${file} row ${rowNumber}: ${key} must be a non-empty string`);
  }
  return value;
}

function documentId(index: string): string {
  return `ragtest-doc-${index}`;
}

function titleFromUrl(sourceUrl: string): string {
  try {
    const pathname = new URL(sourceUrl).pathname.replace(/\/$/, '');
    const lastSegment = pathname.split('/').filter(Boolean).at(-1);
    if (lastSegment) return decodeURIComponent(lastSegment).replace(/[_-]+/g, ' ');
  } catch {
    // Retain the URL as a usable title below when a benchmark row contains a non-URL source value.
  }
  return sourceUrl;
}

export const ragtestAdapter: DatasetAdapter = {
  name: 'ragtest',
  defaultDir: `${process.env.HOME ?? '~'}/Desktop/RAGTest`,
  acquisitionHint: ACQUISITION_HINT,

  async load(dir: string): Promise<DatasetBundle> {
    const [rawDocs, rawSingle, rawMulti, rawNoAnswer] = await Promise.all([
      readCsv(dir, DOCUMENTS_FILE),
      readCsv(dir, SINGLE_FILE),
      readCsv(dir, MULTI_FILE),
      readCsv(dir, NO_ANSWER_FILE),
    ]);
    const docIds = new Set<string>();
    const docs: EvalDocument[] = rawDocs.map((row, index) => {
      const documentIndex = required(row, 'index', DOCUMENTS_FILE, index + 2).trim();
      const id = documentId(documentIndex);
      if (docIds.has(id)) throw new Error(`${DOCUMENTS_FILE} row ${index + 2}: duplicate index ${documentIndex}`);
      docIds.add(id);
      const sourceUrl = required(row, 'source_url', DOCUMENTS_FILE, index + 2).trim();
      return {
        id,
        title: titleFromUrl(sourceUrl),
        body: required(row, 'text', DOCUMENTS_FILE, index + 2),
        metadata: { source_url: sourceUrl },
      };
    });

    const questions: EvalQuestion[] = [];
    const appendAnswerable = (rows: CsvRecord[], file: string, type: string) => {
      rows.forEach((row, index) => {
        const sourceIndex = required(row, 'document_index', file, index + 2).trim();
        const goldId = documentId(sourceIndex);
        if (!docIds.has(goldId)) {
          throw new Error(`${file} row ${index + 2}: document_index ${sourceIndex} does not exist in ${DOCUMENTS_FILE}`);
        }
        questions.push({
          id: `ragtest-${type}-${String(index).padStart(4, '0')}`,
          text: required(row, 'question', file, index + 2),
          goldDocIds: [goldId],
          expectedAnswer: required(row, 'answer', file, index + 2),
          type,
        });
      });
    };
    appendAnswerable(rawSingle, SINGLE_FILE, 'single_passage');
    appendAnswerable(rawMulti, MULTI_FILE, 'multi_passage');
    rawNoAnswer.forEach((row, index) => {
      // Validate the source reference even though it is intentionally excluded from gold evidence.
      const sourceIndex = required(row, 'document_index', NO_ANSWER_FILE, index + 2).trim();
      if (!docIds.has(documentId(sourceIndex))) {
        throw new Error(`${NO_ANSWER_FILE} row ${index + 2}: document_index ${sourceIndex} does not exist in ${DOCUMENTS_FILE}`);
      }
      questions.push({
        id: `ragtest-no-answer-${String(index).padStart(4, '0')}`,
        text: required(row, 'question', NO_ANSWER_FILE, index + 2),
        goldDocIds: [],
        type: 'no_answer',
      });
    });

    return { docs, questions };
  },
};
