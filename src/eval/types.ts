// The one internal shape every RAG benchmark converts into.
//
// WHY A CONTRACT RATHER THAN A MULTIHOP-SHAPED HARNESS. The first draft of this work hard-coded
// MultiHop-RAG's vocabulary (`evidence_list`, `question_type`, `"Insufficient information."`) into
// the loader, the scorer and the report. That is fine until the second dataset, at which point the
// choice is a rewrite or a parallel harness — and this repo already has two eval harnesses that do
// not share a line (`run-a17-eval.ts`, `novabyte-eval.ts`). Everything dataset-specific now lives
// behind `DatasetAdapter`, so adding a benchmark is one new file and a registry entry.
//
// WHY THIS SHAPE AND NOT ANOTHER. It is deliberately BEIR-shaped — the `corpus` / `queries` /
// `qrels` triple that retrieval research standardized on. Dozens of public benchmarks (NFCorpus,
// FiQA, SciFact, HotpotQA, MS MARCO) already ship in that layout, so each becomes a file-reading
// shim rather than a real translator. A bespoke internal format would cost a full adapter every
// time, which is the cost this file exists to avoid.

/** A document to ingest. `id` is whatever the dataset calls a document — it becomes the page slug
 *  via `slugify`, so it must be stable and unique WITHIN the dataset. */
export interface EvalDocument {
  id: string;
  title: string;
  body: string;
  /**
   * Fields the dataset knows and the engine currently cannot index: source, author, published_at.
   *
   * Carried rather than dropped because the harness loads every corpus TWICE — once body-only (what
   * `ingest` does today) and once with these rendered into a header block — and the delta between
   * the two runs is the measurement. Dropping them here would make that comparison unbuildable.
   */
  metadata?: Record<string, string>;
}

/** A question with its ground truth. */
export interface EvalQuestion {
  id: string;
  text: string;
  /**
   * The documents required to answer, as `EvalDocument.id` values (NOT slugs — `slugify` is applied
   * on both sides at scoring time, so an adapter never needs to know the slug rule).
   *
   * EMPTY MEANS UNANSWERABLE, and that is load-bearing rather than a degenerate case: the
   * unanswerable questions are the hallucination suite. An adapter that cannot express "no document
   * answers this" cannot drive the abstention tier at all.
   */
  goldDocIds: string[];
  /** Present when the dataset ships a gold answer string. Unused by the retrieval tier. */
  expectedAnswer?: string;
  /** Dataset-defined class ('temporal_query', 'entity', …). Drives stratification and the per-type
   *  breakdown, which is the report's most actionable table — an aggregate hides that temporal and
   *  entity questions fail for different reasons. */
  type?: string;
}

export interface DatasetBundle {
  docs: EvalDocument[];
  questions: EvalQuestion[];
}

export interface DatasetAdapter {
  /** Registry key, matched by `--dataset`. */
  name: string;
  /** Default on-disk location, overridable with `--dir`. Datasets are never vendored — they are
   *  third-party data with their own licences and sizes. */
  defaultDir: string;
  /** Human-facing acquisition recipe, printed verbatim when `defaultDir` holds nothing. A
   *  "dataset not found" message that does not say how to GET the dataset is the single most
   *  common way an eval harness becomes unrunnable six months later. */
  acquisitionHint: string;
  load(dir: string): Promise<DatasetBundle>;
}
