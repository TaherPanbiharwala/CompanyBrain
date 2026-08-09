// MultiHop-RAG (https://huggingface.co/datasets/yixuantt/MultiHopRAG, ODC-BY).
//
// EVERY MultiHop-SPECIFIC FACT IN THE HARNESS LIVES HERE. Deleting this file removes all trace of
// the dataset — `evidence_list`, `question_type`, the literal `"Insufficient information."`, the
// HuggingFace snapshot layout. That is the point of the adapter seam: the core knows about
// documents, questions and gold ids, and nothing else.
//
// Verified against the actual files (2026-08): 609 documents, 2,556 questions, 6,084 evidence
// entries with zero dangling URLs, 301 null questions all carrying `"Insufficient information."`
// with an empty evidence list, every `url` and `title` unique.
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatasetAdapter, DatasetBundle, EvalDocument, EvalQuestion } from '../types.ts';

interface RawDoc {
  title: string;
  /** NULLABLE, measured: 64 of 609 corpus documents and 290 of 6,084 evidence entries have a JSON
   *  `null` here. Every other field in both files is always a string. Typing this `string` cost a
   *  hard failure on document 0 the first time the adapter ran. */
  author: string | null;
  source: string;
  published_at: string;
  category: string;
  url: string;
  body: string;
}

interface RawEvidence {
  title: string;
  author: string | null;
  url: string;
  source: string;
  category: string;
  published_at: string;
  fact: string;
}

interface RawQuestion {
  query: string;
  answer: string;
  question_type: string;
  evidence_list: RawEvidence[];
}

const CORPUS_FILE = 'corpus.json';
const QA_FILE = 'MultiHopRAG.json';

/**
 * `hf download` writes into a cache layout where the real files sit under a content-addressed
 * snapshot directory, and the checkout at ~/Desktop/Datasets/MultiHopRAG contains BOTH a flat copy
 * and a `<sha>/` subdirectory holding duplicates. A naive `join(dir, 'corpus.json')` finds the flat
 * layout and reports "dataset not found" for a perfectly good `hf download` cache, which is the
 * least helpful possible failure for the step that is hardest to redo from memory.
 */
async function resolveDatasetDir(dir: string): Promise<string> {
  const hasBoth = async (d: string): Promise<boolean> => {
    try {
      await stat(join(d, CORPUS_FILE));
      await stat(join(d, QA_FILE));
      return true;
    } catch {
      return false;
    }
  };

  if (await hasBoth(dir)) return dir;

  // Look one level down: `snapshots/<sha>/` and the bare `<sha>/` form both appear in the wild.
  for (const candidate of ['snapshots', '.']) {
    const base = candidate === '.' ? dir : join(dir, candidate);
    let entries: string[];
    try {
      entries = await readdir(base);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      const nested = join(base, entry);
      if (await hasBoth(nested)) return nested;
    }
  }

  throw new Error(
    `No MultiHop-RAG dataset at ${dir} (looked for ${CORPUS_FILE} and ${QA_FILE}, ` +
      `flat and under a snapshot subdirectory).\n${ACQUISITION_HINT}`,
  );
}

const ACQUISITION_HINT =
  `Get it:\n` +
  `  hf download yixuantt/MultiHopRAG --repo-type dataset --local-dir ~/Desktop/Datasets/MultiHopRAG\n` +
  `Or point --dir / MULTIHOP_DIR at an existing checkout.\n` +
  `Licence ODC-BY, ~12MB. Deliberately not vendored: third-party data with its own licence.`;

/** Parse + shape-check together. A truncated download yields valid JSON of the wrong shape far more
 *  often than a syntax error, and "cannot read property 'url' of undefined" 400 documents into a
 *  paid load is a much worse failure than a refusal at startup. */
async function readJsonArray<T>(path: string, validate: (row: unknown, i: number) => T): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${path}: ${(err as Error).message}\n${ACQUISITION_HINT}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${(err as Error).message}) — a truncated download?`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${path} must contain a JSON array, got ${typeof parsed}`);
  if (parsed.length === 0) throw new Error(`${path} is an empty array`);
  return parsed.map(validate);
}

function str(row: Record<string, unknown>, key: string, path: string, i: number): string {
  const v = row[key];
  if (typeof v !== 'string') throw new Error(`${path}[${i}].${key} must be a string, got ${typeof v}`);
  return v;
}

/** For fields the dataset leaves as JSON `null` rather than omitting. Returns null for both `null`
 *  and an empty/whitespace string, so downstream code has one "absent" case instead of three. */
function nullableStr(row: Record<string, unknown>, key: string, path: string, i: number): string | null {
  const v = row[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') {
    throw new Error(`${path}[${i}].${key} must be a string or null, got ${typeof v}`);
  }
  return v.trim().length === 0 ? null : v;
}

function asRecord(row: unknown, path: string, i: number): Record<string, unknown> {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(`${path}[${i}] must be an object`);
  }
  return row as Record<string, unknown>;
}

export const multihopAdapter: DatasetAdapter = {
  name: 'multihop',
  defaultDir: `${process.env.HOME ?? '~'}/Desktop/Datasets/MultiHopRAG`,
  acquisitionHint: ACQUISITION_HINT,

  async load(dir: string): Promise<DatasetBundle> {
    const root = await resolveDatasetDir(dir);
    const corpusPath = join(root, CORPUS_FILE);
    const qaPath = join(root, QA_FILE);

    const rawDocs = await readJsonArray<RawDoc>(corpusPath, (row, i) => {
      const r = asRecord(row, corpusPath, i);
      return {
        title: str(r, 'title', corpusPath, i),
        author: nullableStr(r, 'author', corpusPath, i),
        source: str(r, 'source', corpusPath, i),
        published_at: str(r, 'published_at', corpusPath, i),
        category: str(r, 'category', corpusPath, i),
        url: str(r, 'url', corpusPath, i),
        body: str(r, 'body', corpusPath, i),
      };
    });

    const rawQuestions = await readJsonArray<RawQuestion>(qaPath, (row, i) => {
      const r = asRecord(row, qaPath, i);
      const ev = r['evidence_list'];
      if (!Array.isArray(ev)) throw new Error(`${qaPath}[${i}].evidence_list must be an array`);
      return {
        query: str(r, 'query', qaPath, i),
        answer: str(r, 'answer', qaPath, i),
        question_type: str(r, 'question_type', qaPath, i),
        evidence_list: ev.map((e, j) => {
          const er = asRecord(e, `${qaPath}[${i}].evidence_list`, j);
          return { ...er, url: str(er, 'url', `${qaPath}[${i}].evidence_list`, j) } as RawEvidence;
        }),
      };
    });

    // The URL is the document id: unique across the corpus (verified) and the same key the evidence
    // list references, so the join needs no title matching or fuzzy comparison anywhere.
    const docs: EvalDocument[] = rawDocs.map((d) => ({
      id: d.url,
      title: d.title,
      body: d.body,
      metadata: {
        source: d.source,
        // Omitted entirely when absent (64 of 609). Rendering `Author: null` into a document body
        // for the metadata arm of the A/B would add a misleading token to the index, not a fact.
        ...(d.author ? { author: d.author } : {}),
        published_at: d.published_at,
        category: d.category,
      },
    }));

    const questions: EvalQuestion[] = rawQuestions.map((q, i) => ({
      // The dataset ships no question id. Index-derived is stable for a given file, and the run
      // manifest records the file's hash — so a dataset that changed underneath a `--resume` is
      // detectable there rather than silently renumbering here.
      id: `mh-${String(i).padStart(4, '0')}`,
      text: q.query,
      // DEDUPED: a question can cite two facts from the SAME article, so `evidence_list.length`
      // overcounts documents. Measured: 1,079 questions have 2 evidence entries but 1,169 have 2
      // distinct documents — scoring against the raw count would demand documents that do not exist.
      goldDocIds: [...new Set(q.evidence_list.map((e) => e.url))],
      expectedAnswer: q.answer,
      type: q.question_type,
    }));

    return { docs, questions };
  },
};
