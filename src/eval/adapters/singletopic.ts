// Kaggle "Single-Topic RAG Evaluation Dataset"
// (https://www.kaggle.com/datasets/samuelmatsuoharris/single-topic-rag-evaluation-dataset).
//
// EVERY DATASET-SPECIFIC FACT LIVES HERE — see multihop.ts's own header for why that separation
// exists. Verified against the actual files (2026-09): 20 documents (2,750-211,933 chars, each a
// full page on an UNRELATED topic — game wikis, an arXiv PDF, EU policy, a TV transcript, cooking —
// "single-topic" describes each document's internal focus, not a shared subject across the corpus),
// 40 single-passage questions, 40 multi-passage questions, 40 no-answer questions, all keyed to
// documents.csv's `index` column (0-19) via a `document_index` column.
//
// SHAPE DIFFERS FROM MultiHop IN ONE IMPORTANT WAY: every question here has AT MOST ONE gold
// document. "multi passage" means the answer needs several PASSAGES from the SAME document, not
// several documents — there is no cross-document multi-hop in this dataset. That makes
// distinct-docs-in-context and evidence-recall (built for multi-DOCUMENT gold sets) degenerate to
// 0-or-1 here and say nothing useful; hit@k/MRR (does retrieval surface the one right document at
// all) and the --nulls abstention tier are the metrics actually worth reading for this dataset.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import type { DatasetAdapter, DatasetBundle, EvalDocument, EvalQuestion } from '../types.ts';

const DOCS_FILE = 'documents.csv';
const SINGLE_FILE = 'single_passage_answer_questions.csv';
const MULTI_FILE = 'multi_passage_answer_questions.csv';
const NULL_FILE = 'no_answer_questions.csv';

const ACQUISITION_HINT =
  `Get it:\n` +
  `  Download "single-topic-rag-evaluation-dataset" from\n` +
  `  https://www.kaggle.com/datasets/samuelmatsuoharris/single-topic-rag-evaluation-dataset\n` +
  `  and unzip it to --dir / SINGLETOPIC_DIR (expects ${DOCS_FILE}, ${SINGLE_FILE}, ${MULTI_FILE}, ${NULL_FILE}).\n` +
  `Kaggle lists no explicit licence: treat as evaluation-only, do not redistribute.`;

/** Same bound the `ingest` op enforces (MAX_BODY_CHARS in src/api/operations.ts), minus headroom for
 *  the `meta` variant's prepended "source: <url>" header (withMetadataHeader in scripts/eval-common.ts)
 *  — without the margin, a document sized to just fit the plain variant would overflow the instant the
 *  header is added, and only the meta half of the plain/meta A/B would fail to load. Measured: 1 of 20
 *  documents (index 16, Stardew Valley's "Version History" page, ~212k chars) exceeds the raw cap;
 *  every other document is under 76k and nowhere near it. */
const SAFE_BODY_CHARS = 195_000;

async function readCsv(path: string): Promise<Record<string, string>[]> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (err) {
    throw new Error(`cannot read ${path}: ${(err as Error).message}\n${ACQUISITION_HINT}`);
  }
  // SheetJS, not a hand-rolled line splitter: documents.csv's `text` column embeds raw newlines
  // inside quoted fields (these are full articles, not single-line records), and a splitter that cuts
  // the file on '\n' BEFORE parsing quotes — the same shape src/ingest/extract/text.ts's extractCsv
  // uses for uploaded files — shreds every one of those 20 rows into dozens of bogus partial rows.
  // Verified: SheetJS round-trips row 0's 147 embedded newlines and document 16's full ~212k chars
  // intact. xlsx is already a project dependency (src/ingest/extract/xlsx.ts).
  const wb = XLSX.read(bytes, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]!];
  if (!sheet) throw new Error(`${path}: no sheet found`);
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' }) as Record<string, unknown>[];
  if (rows.length === 0) throw new Error(`${path} is empty`);
  // Stringify every cell up front: SheetJS types a numeric-looking column (index, document_index) as
  // a JS number, not a string, and the two files must agree on the join key's TYPE as well as its
  // value for `document_index` to ever equal `index`.
  return rows.map((row) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(row)) out[k] = String(v ?? '');
    return out;
  });
}

function field(row: Record<string, string>, key: string, path: string, i: number): string {
  const v = row[key];
  if (v === undefined) throw new Error(`${path}[${i}] is missing column "${key}"`);
  return v;
}

export const singletopicAdapter: DatasetAdapter = {
  name: 'singletopic',
  defaultDir: `${process.env.HOME ?? '~'}/Desktop/RAGTest`,
  acquisitionHint: ACQUISITION_HINT,

  async load(dir: string): Promise<DatasetBundle> {
    const docsPath = join(dir, DOCS_FILE);
    const rawDocs = await readCsv(docsPath);

    const docs: EvalDocument[] = rawDocs.map((row, i) => {
      const id = field(row, 'index', docsPath, i);
      const sourceUrl = field(row, 'source_url', docsPath, i);
      const text = field(row, 'text', docsPath, i);
      // The corpus repeats the page's own title as the first line of `text` (verified: all 20 rows —
      // e.g. document 0's body opens "Bullet Kin\nBullet Kin are one of…"). Falling back to the URL's
      // last path segment covers a row where that stops holding, rather than shipping a title the
      // `ingest` op's min(1) would reject outright.
      const firstLine = text.split('\n', 1)[0]!.trim();
      const title =
        firstLine.length > 0 && firstLine.length <= 300
          ? firstLine
          : (sourceUrl.split('/').filter(Boolean).pop() ?? `document ${id}`).replace(/[_-]+/g, ' ');
      return {
        id,
        title,
        body: text.length > SAFE_BODY_CHARS ? text.slice(0, SAFE_BODY_CHARS) : text,
        metadata: { source: sourceUrl },
      };
    });

    const docIds = new Set(docs.map((d) => d.id));
    const checkDocIndex = (row: Record<string, string>, path: string, i: number): string => {
      const idx = field(row, 'document_index', path, i);
      if (!docIds.has(idx)) {
        throw new Error(
          `${path}[${i}]: document_index "${idx}" is not in ${DOCS_FILE} (ids: ${[...docIds].join(', ')})`,
        );
      }
      return idx;
    };

    const questions: EvalQuestion[] = [];

    const singlePath = join(dir, SINGLE_FILE);
    (await readCsv(singlePath)).forEach((row, i) => {
      questions.push({
        id: `sp-${String(i).padStart(4, '0')}`,
        text: field(row, 'question', singlePath, i),
        goldDocIds: [checkDocIndex(row, singlePath, i)],
        expectedAnswer: field(row, 'answer', singlePath, i),
        type: 'single_passage',
      });
    });

    const multiPath = join(dir, MULTI_FILE);
    (await readCsv(multiPath)).forEach((row, i) => {
      questions.push({
        id: `mp-${String(i).padStart(4, '0')}`,
        text: field(row, 'question', multiPath, i),
        // ONE gold document, not several — see this file's header comment.
        goldDocIds: [checkDocIndex(row, multiPath, i)],
        expectedAnswer: field(row, 'answer', multiPath, i),
        type: 'multi_passage',
      });
    });

    const nullPath = join(dir, NULL_FILE);
    (await readCsv(nullPath)).forEach((row, i) => {
      // document_index IS present in this file but deliberately NOT used as a gold id: the dataset's
      // own premise is that this document does not answer the question. Putting it in goldDocIds
      // would score a correct abstention as a retrieval MISS, and would let a hallucinated answer
      // sourced from that document score as a HIT — exactly backwards for what this tier catches.
      // EMPTY is what routes a question into the --nulls tier at all (see src/eval/types.ts).
      checkDocIndex(row, nullPath, i); // still validated, so a typo'd index fails loudly, not silently
      questions.push({
        id: `na-${String(i).padStart(4, '0')}`,
        text: field(row, 'question', nullPath, i),
        goldDocIds: [],
        type: 'no_answer',
      });
    });

    return { docs, questions };
  },
};
