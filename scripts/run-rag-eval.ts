// The RAG evaluation harness. Retrieval scoring by default; `--nulls` adds the hallucination tier.
//
// WHAT THIS MEASURES, AND WHAT IT DELIBERATELY DOES NOT. Retrieval scoring never calls the chat
// model, so it is immune to the thing that makes answer-correctness uninterpretable on a public
// benchmark: the model already knows the answers. MultiHop-RAG is news from Sept-Dec 2023 and
// CHAT_MODEL is a 2026 web-trained model; the gold answers are dominated by Sam Bankman-Fried (271),
// Google (211), Sam Altman (56), and there are only 107 distinct answers across 2,255 answerable
// questions. So answer CORRECTNESS is not scored here at all — it belongs on a corpus no model has
// memorized. Abstention on the 301 unanswerable questions IS scored, because contamination makes
// that suite sharper rather than weaker: a confident memory-driven answer to a question the corpus
// cannot answer is precisely the defect being hunted.
//
// WHAT A NUMBER FROM HERE MAY JUSTIFY. An earlier version of this comment said no tuning change
// could ever be justified by this harness, on the premise that real traffic is mostly single-hop
// while every question here is multi-hop. That premise was assumed, never evidenced, and the founder
// has since stated the opposite: real work does pull from several documents at once. So tuning
// against this benchmark is legitimate — but promotion into production defaults still requires a
// second corpus the model has not memorized, because answer correctness is unmeasurable here and a
// config can raise document recall while lowering answer quality.
import { writeFileSync, appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closePools, withScopedTx } from '../src/db/client.ts';
import { config } from '../src/config.ts';
import { hybridSearch, DEFAULT_TOP_K } from '../src/search/hybrid.ts';
import { answerQuestion } from '../src/answer/answer.ts';
import { isRerankEnabled, isExpansionEnabled } from '../src/ai/router.ts';
import { scoreMultiHop, scoreCandidateRecall, type MultiHopScore } from '../src/search/eval-score.ts';
import { resolveAdapter } from '../src/eval/adapters/index.ts';
import { goldSlugs, stratifiedSample, classifyAbstention, type AbstentionVerdict } from '../src/eval/core.ts';
import type { EvalQuestion } from '../src/eval/types.ts';
import {
  parseArgs, say, ctxFor, loadWorkspaces, VARIANTS, EVAL_DIR, knownDatasets, intArg,
  type Variant, type CommonArgs,
} from './eval-common.ts';
import type { OperationContext } from '../src/core/context.ts';

/** Cutoffs actually reachable by a caller. `answerQuestion` is hardwired to DEFAULT_TOP_K (8) and
 *  the public `search` op caps `limit` at 20, so reporting recall@24 would produce a finding whose
 *  action item ("raise topK to 24") nobody can take without also lifting the op cap. */
const REPORT_KS = [4, 8, 12, 16, 20];

/**
 * One retrieval per question, at a topK generous enough to be BOTH the ranked list we slice and the
 * candidate pool we measure against.
 *
 * Every baseline arm is capped independently of topK (candidatePool vector/AND/OR/title =
 * 20/20/10/10), so fusion never sees more than ~60 chunks. Asking for 60 therefore returns
 * everything that survived fusion, which is the pool `candidate-recall` needs. The REPORTED cutoffs
 * stay 4..20; the tail past 20 is used only to answer "was the gold document ever a candidate at
 * all", never quoted as a production recall number.
 */
const POOL_K = 60;

/** DB_POOL_MAX is 10 and each `hybridSearch` holds one pooled connection for its transaction, so
 *  this stays comfortably under it — the same bound `load-eval-corpus.ts` uses. */
const CONCURRENCY = 4;

const HELP = `
bun run eval:rag [--dataset <name>] [options]

Retrieval scoring by default (no LLM calls). --nulls adds the hallucination tier.

  --dataset <name>    Benchmark to run. Default: multihop. Known: ${knownDatasets()}
  --dir <path>        Override the dataset location (also reads MULTIHOP_DIR).
  --variant <v>       Score only "plain" or "meta". Default: both, and report the delta.
  --sample <N>        Stratified subset of N questions, proportional across types.
  --sample-seed <N>   Seed for --sample. Default: 42. Same seed -> same questions.
  --type <t>          Only questions of one type (e.g. temporal_query; the _query suffix is optional).
  --nulls             Run the hallucination tier on the unanswerable questions (~$2 for 301). Uses the
                      chat model, at topK=${DEFAULT_TOP_K} (answerQuestion takes no k).
  --dry-run           Resolve everything, print the manifest and the plan, spend nothing.
  --resume <run-id>   Continue a checkpointed run, skipping questions already scored.
  --allow-paid-retrieval  Proceed even when query expansion or reranking is enabled.
  --help              This text.

SMOKE=1 is an alias for --sample 40.
`;

// ── Manifest ────────────────────────────────────────────────────────────────

function gitState(): { sha: string; dirty: boolean } {
  try {
    const sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0;
    return { sha, dirty };
  } catch {
    return { sha: 'unknown', dirty: false };
  }
}

interface Manifest {
  dataset: string;
  datasetDir: string;
  datasetHash: string;
  gitSha: string;
  gitDirty: boolean;
  chatModel: string;
  embeddingModel: string;
  embeddingDim: number;
  defaultTopK: number;
  poolK: number;
  reportKs: number[];
  maxPerPage: number;
  /** All four recorded, because they bound the candidate pool and `candidateRecall` is meaningless
   *  without knowing them. The manifest previously recorded none, so two reports run under different
   *  arm caps were indistinguishable after the fact. */
  armCaps: { armLimit: number; kwAndSlots: number; kwOrSlots: number; titleLimit: number; sum: number };
  autocutRatio: number;
  rerankModel: string;
  queryExpansion: number;
  chunkSize: string;
  sampleSeed: number;
  questionCount: number;
  workspaces: Record<string, { id: string; pages: number; chunks: number }>;
  degradedCount: number;
  erroredCount: number;
  startedAt: string;
}

// ── Row shape (one JSONL line per scored question) ──────────────────────────

/** Bumped whenever a field below changes meaning. `--resume` refuses across a mismatch: resuming a
 *  pre-v2 checkpoint would silently mix rows that have `rankedSlugs` with rows that do not, and the
 *  replay would then score half the set while reporting a denominator that looks whole. */
const ROW_SCHEMA_VERSION = 2;

interface Row {
  v: number;
  qid: string;
  variant: Variant;
  type: string | null;
  goldCount: number;
  degraded: string | null;
  error: string | null;
  score: MultiHopScore | null;
  candidateRecall: number | null;
  /**
   * The PER-CHUNK slug list, in rank order, WITH REPEATS. Not the distinct-document list.
   *
   * This is what makes a per-page cap simulable offline, and the distinction is the whole point: a
   * cap operates on MULTIPLICITY, so given only distinct documents every page already appears once
   * and a cap of 2 is a no-op. `[A,B,C,D]` is equally consistent with `A,A,A,B,B,C,D,D` (cap 2 -> 5
   * docs) and `A,B,C,D,A,B,C,D` (cap 2 -> no change), and nothing distinguishes them.
   *
   * Simulating from a cap-3 log is legitimate by composition: filter(filter(L,<=3),<=2) =
   * filter(L,<=2), because the <=2 filter keeps the first two occurrences and both survive <=3.
   *
   * APPROXIMATE, and a simulator built on it must be oracle-tested against the engine: `page_rk` is
   * computed over the RRF score while the returned order is the 0.7*rrf + 0.3*cos blend, so the
   * third occurrence of a page here is not necessarily its `page_rk = 3`.
   */
  rankedSlugs: string[];
  /** The documents this question required. Logged alongside `rankedSlugs` because a replay needs
   *  BOTH: the ranked list says what a config would return, and this says whether that is correct.
   *  With only `goldCount` a simulation can report how the result set changed but not whether it got
   *  better, which is the only question worth asking. */
  goldSlugs: string[];
  /** Distinct documents across the whole returned pool — the ceiling ranking could reach. */
  poolSize: number;
  /** Wall clock for the retrieval call. Recorded because the 4.6s regression went unnoticed for
   *  exactly as long as nothing measured it. Replay is for ranking; latency is live-only. */
  latencyMs: number;
  /** --nulls only. */
  abstention?: AbstentionVerdict;
  jsonParseDegraded?: boolean;
  answer?: string;
}

async function scoreOne(
  ctx: OperationContext,
  q: EvalQuestion,
  variant: Variant,
): Promise<Row> {
  const base: Row = {
    v: ROW_SCHEMA_VERSION,
    qid: q.id, variant, type: q.type ?? null, goldCount: q.goldDocIds.length,
    degraded: null, error: null, score: null, candidateRecall: null,
    rankedSlugs: [], goldSlugs: [], poolSize: 0, latencyMs: 0,
  };
  const started = Date.now();
  try {
    const { hits, degraded } = await hybridSearch(ctx, q.text, { topK: POOL_K });
    // Per-chunk, with repeats — see the Row.rankedSlugs comment. scoreMultiHop dedups internally.
    const ranked = hits.map((h) => h.slug);
    const gold = goldSlugs(q);
    return {
      ...base,
      latencyMs: Date.now() - started,
      degraded: degraded ?? null,
      score: scoreMultiHop(gold, ranked, REPORT_KS),
      candidateRecall: scoreCandidateRecall(gold, ranked),
      rankedSlugs: ranked,
      goldSlugs: [...gold],
      poolSize: new Set(ranked).size,
    };
  } catch (err) {
    return { ...base, latencyMs: Date.now() - started, error: (err as Error).message };
  }
}

async function abstentionOne(ctx: OperationContext, q: EvalQuestion, variant: Variant): Promise<Row> {
  const base: Row = {
    v: ROW_SCHEMA_VERSION,
    qid: q.id, variant, type: q.type ?? null, goldCount: 0,
    degraded: null, error: null, score: null, candidateRecall: null,
    rankedSlugs: [], goldSlugs: [], poolSize: 0, latencyMs: 0,
  };
  const started = Date.now();
  try {
    const { answer, citations, degraded, parseDegraded } = await answerQuestion(ctx, q.text);
    return {
      ...base,
      latencyMs: Date.now() - started,
      degraded: degraded ?? null,
      abstention: classifyAbstention(answer, citations),
      // Reported from the parser itself, not inferred. The degrade path DROPS the citation array, so
      // `citations: []` alone cannot distinguish "cited nothing" from "we could not read what it
      // cited" — and the second scored as a clean abstention would inflate the headline number.
      jsonParseDegraded: parseDegraded,
      answer: answer.slice(0, 500),
    };
  } catch (err) {
    return { ...base, latencyMs: Date.now() - started, error: (err as Error).message };
  }
}

// ── Aggregation ─────────────────────────────────────────────────────────────

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function aggregate(rows: Row[], ks: number[]) {
  const scored = rows.filter((r) => r.score && !r.degraded && !r.error);
  const perK = ks.map((k) => {
    const at = scored.map((r) => r.score!.perK.find((p) => p.k === k)!);
    const withGold = at.filter((p) => p.allEvidenceRecall !== null);
    return {
      k,
      allEvidenceRecall: mean(withGold.map((p) => p.allEvidenceRecall!)),
      evidenceRecall: mean(withGold.map((p) => p.evidenceRecall!)),
      // hit@1 and MRR are averaged over questions WITH gold documents too. A question that has no
      // gold documents can never register a hit, so including them would silently depress both by
      // exactly the share of unanswerable questions in the set. The retrieval tier filters those out
      // already, but the aggregate must not depend on the caller having done that.
      hitAt1: mean(withGold.map((p) => (p.hitAt1 ? 1 : 0))),
      mrr: mean(withGold.map((p) => p.reciprocalRank)),
      distinctDocs: mean(at.map((p) => p.distinctDocs)), // context shape: valid for every question
      n: withGold.length,
    };
  });
  const cr = scored.map((r) => r.candidateRecall).filter((x): x is number => x !== null);
  return { perK, candidateRecall: mean(cr), scoredCount: scored.length };
}

function table(rows: string[][]): string {
  const head = rows[0]!;
  const sep = head.map(() => '---');
  return [head, sep, ...rows.slice(1)].map((r) => `| ${r.join(' | ')} |`).join('\n');
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    say(HELP);
    return;
  }

  const args: CommonArgs = parseArgs(argv);
  const adapter = resolveAdapter(args.dataset);
  const { docs, questions: allQuestions } = await adapter.load(args.dir);
  const retrievalKnobs = config.retrievalKnobs;

  // ── Preflight: refuse before doing anything expensive or misleading ────────

  // Slicing one ranked list at several k is valid ONLY while autocut is off. Autocut runs AFTER the
  // topK slice, so with it enabled a k=20 run and a real k=8 run drop different tails and every
  // sliced number would describe a result set no query would ever return.
  if (retrievalKnobs.fusion.autocutRatio !== 0) {
    throw new Error(
      `retrieval autocutRatio is ${retrievalKnobs.fusion.autocutRatio}, not 0. This harness slices ONE k=${POOL_K} retrieval to ` +
        `produce recall at k=${REPORT_KS.join('/')}, which autocut invalidates — it runs after the ` +
        `topK slice, so the sliced numbers would describe result sets no real query returns.`,
    );
  }
  // POOL_K is only "the whole pre-fusion pool" because the four arm caps happen to sum to exactly 60.
  // Raise any of them — which is one of the levers this harness exists to evaluate — and the pool
  // silently truncates, making `candidateRecall` an undetected underestimate. That number is the sole
  // basis for telling a ranking failure apart from arm starvation, so a quiet underestimate would
  // send the whole diagnosis the wrong way.
  const armSum = retrievalKnobs.candidatePool.vectorLimit +
    retrievalKnobs.candidatePool.keywordAndLimit +
    retrievalKnobs.candidatePool.keywordOrLimit +
    retrievalKnobs.candidatePool.titleLimit;
  if (armSum > POOL_K) {
    throw new Error(
      `arm caps sum to ${armSum} but POOL_K is ${POOL_K}, so the retrieval pool this harness reads ` +
        `is truncated and candidateRecall would silently understate. Raise POOL_K to at least ` +
        `${armSum} (vectorLimit=${retrievalKnobs.candidatePool.vectorLimit}, ` +
        `keywordAndLimit=${retrievalKnobs.candidatePool.keywordAndLimit}, ` +
        `keywordOrLimit=${retrievalKnobs.candidatePool.keywordOrLimit}, ` +
        `titleLimit=${retrievalKnobs.candidatePool.titleLimit}).`,
    );
  }
  if (isRerankEnabled()) {
    throw new Error(
      `RERANK_MODEL is set (${config.RERANK_MODEL}). Reranking makes fetchK depend on topK ` +
        `(fetchK = topK * candidatePool.rerankOverfetch), so the top-8 of a k=${POOL_K} run is NOT a k=8 run and ` +
        `the sweep would be measuring the reranker rather than retrieval. Re-run with ` +
        `RERANK_MODEL= bun run eval:rag …`,
    );
  }
  if (isExpansionEnabled() && !args.flags.has('allow-paid-retrieval')) {
    throw new Error(
      `QUERY_EXPANSION=${config.QUERY_EXPANSION} makes a PAID chat() call per question, so this ` +
        `"free" retrieval run would make ${allQuestions.length} of them. Re-run with ` +
        `QUERY_EXPANSION=0, or pass --allow-paid-retrieval if you meant it.`,
    );
  }

  const state = loadWorkspaces(args.dataset);
  const only = args.values.get('variant') as Variant | undefined;
  if (only && !VARIANTS.includes(only)) {
    throw new Error(`--variant must be one of: ${VARIANTS.join(', ')}. Got "${only}"`);
  }
  const variants = only ? [only] : VARIANTS;

  // ── Question selection ────────────────────────────────────────────────────
  const nulls = args.flags.has('nulls');
  let questions = allQuestions;

  const typeArg = args.values.get('type');
  if (typeArg) {
    const want = typeArg.endsWith('_query') ? typeArg : `${typeArg}_query`;
    const known = [...new Set(allQuestions.map((q) => q.type).filter(Boolean))] as string[];
    if (!known.includes(want)) {
      throw new Error(`--type must be one of: ${known.join(', ')} (the _query suffix is optional). Got "${typeArg}"`);
    }
    questions = questions.filter((q) => q.type === want);
  }

  // The hallucination tier is defined by the ground truth (no gold documents), not by a type name —
  // that keeps it working for any adapter, including ones with no type field at all.
  questions = nulls
    ? questions.filter((q) => q.goldDocIds.length === 0)
    : questions.filter((q) => q.goldDocIds.length > 0);

  const seed = intArg(args, 'sample-seed', 42);
  const sampleN = process.env.SMOKE === '1' ? 40 : intArg(args, 'sample', 0);
  if (sampleN > 0) questions = stratifiedSample(questions, sampleN, seed);

  if (questions.length === 0) throw new Error('no questions selected — check --type / --sample / --nulls');

  // ── Corpus presence: the check that makes "recall = 0.00" diagnosable ──────
  // A flat zero has four indistinguishable causes: broken slug join, corpus never loaded, partial
  // load, or wrong workspace. Reading the workspace's slugs once tells them apart for free.
  // In --dry-run the corpus is REPORTED, not required: the whole point of a dry run is to see the
  // plan and the cost before committing to anything, and the most useful moment to do that is before
  // the load has happened at all.
  const dryRun = args.flags.has('dry-run');
  const workspaceStats: Manifest['workspaces'] = {};
  for (const variant of variants) {
    const ws = state.workspaces[variant];
    const ctx = await ctxFor(state.principalId, ws.workspaceId);
    const counts = await withScopedTx(ctx, async (tx) =>
      tx<{ pages: number; chunks: number }[]>`
        select (select count(*)::int from pages) as pages,
               (select count(*)::int from content_chunks) as chunks`);
    const pages = counts[0]?.pages ?? 0;
    const chunks = counts[0]?.chunks ?? 0;
    workspaceStats[variant] = { id: ws.workspaceId, pages, chunks };

    if (pages >= docs.length) {
      say(`corpus check ${variant}: ${pages}/${docs.length} pages, ${chunks} chunks. OK`);
      continue;
    }
    const detail = pages === 0
      ? `0 of ${docs.length} documents found in the ${variant} workspace (${ws.workspaceId}, "${ws.name}")`
      : `${pages} of ${docs.length} documents in the ${variant} workspace — ${docs.length - pages} missing`;
    const fix = `Run:  bun run load:eval --dataset ${args.dataset}` +
      (pages === 0 ? '' : '  (it skips what is already there)');
    if (dryRun) {
      say(`corpus check ${variant}: ${detail}. ${fix}`);
    } else {
      throw new Error(`corpus check: ${detail}.\n${fix}\nRefusing to score a partial corpus.`);
    }
  }

  const git = gitState();
  const datasetHash = createHash('sha256')
    .update(`${docs.length}:${allQuestions.length}:${docs[0]?.id ?? ''}:${allQuestions[0]?.id ?? ''}`)
    .digest('hex')
    .slice(0, 16);

  const manifest: Manifest = {
    dataset: args.dataset,
    datasetDir: args.dir,
    datasetHash,
    gitSha: git.sha,
    gitDirty: git.dirty,
    chatModel: nulls ? config.CHAT_MODEL : '(not used — retrieval tier makes no chat calls)',
    embeddingModel: config.EMBEDDING_MODEL,
    embeddingDim: 1536,
    defaultTopK: DEFAULT_TOP_K,
    poolK: POOL_K,
    reportKs: REPORT_KS,
    maxPerPage: retrievalKnobs.candidatePool.maxPerPage,
    armCaps: {
      armLimit: retrievalKnobs.candidatePool.vectorLimit,
      kwAndSlots: retrievalKnobs.candidatePool.keywordAndLimit,
      kwOrSlots: retrievalKnobs.candidatePool.keywordOrLimit,
      titleLimit: retrievalKnobs.candidatePool.titleLimit,
      sum: armSum,
    },
    autocutRatio: retrievalKnobs.fusion.autocutRatio,
    rerankModel: config.RERANK_MODEL || '(off)',
    queryExpansion: config.QUERY_EXPANSION,
    chunkSize: 'chunkText: 300 words, overlap 50, maxChars 6000',
    sampleSeed: seed,
    questionCount: questions.length,
    workspaces: workspaceStats,
    degradedCount: 0,
    erroredCount: 0,
    startedAt: new Date().toISOString(),
  };

  const runId = `${manifest.startedAt.replace(/[:.]/g, '-')}-${git.sha}`;
  const runsDir = join(EVAL_DIR, 'runs');
  mkdirSync(runsDir, { recursive: true });
  const jsonlPath = join(runsDir, `${args.dataset}-${runId}.jsonl`);
  const mdPath = join(runsDir, `${args.dataset}-${runId}.md`);

  if (dryRun) {
    say('\n--- DRY RUN: nothing has been spent ---');
    say(JSON.stringify(manifest, null, 2));
    say(`\nWould score ${questions.length} question(s) x ${variants.length} variant(s) = ` +
        `${questions.length * variants.length} retrievals.`);
    say(nulls
      ? `--nulls: ${questions.length} chat calls at topK=${DEFAULT_TOP_K}, roughly $2 for the full 301.`
      : `Retrieval tier: no chat calls. Query embeddings only, roughly $0.05.`);
    say(`Would write ${jsonlPath}`);
    await closePools({ timeout: 5 });
    return;
  }

  // ── Resume ────────────────────────────────────────────────────────────────
  const resumeId = args.values.get('resume');
  const done = new Set<string>();
  /** Rows recovered from the checkpoint. Kept SEPARATE from `rows` so they are not appended to the
   *  JSONL a second time, but folded back in at report time — a resumed run must report on the whole
   *  question set, not only the part that happened after the interruption. */
  const priorRows: Row[] = [];
  let outPath = jsonlPath;
  if (resumeId) {
    outPath = join(runsDir, `${args.dataset}-${resumeId}.jsonl`);
    if (!existsSync(outPath)) throw new Error(`no checkpoint at ${outPath}`);
    for (const line of readFileSync(outPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as Row;
      // Refuse across a schema change rather than silently mixing shapes. A pre-v2 checkpoint has no
      // `rankedSlugs`, so resuming onto it would score half the set while reporting a denominator
      // that looks whole — the failure is invisible in the output.
      if ((r.v ?? 1) !== ROW_SCHEMA_VERSION) {
        throw new Error(
          `checkpoint ${resumeId} was written at row schema v${r.v ?? 1}, this build writes ` +
            `v${ROW_SCHEMA_VERSION}. Resuming would mix row shapes and report a denominator that ` +
            `looks whole while half the rows lack the newer fields. Start a fresh run.`,
        );
      }
      done.add(`${r.variant}:${r.qid}`);
      priorRows.push(r);
      if (r.degraded) manifest.degradedCount++;
      if (r.error) manifest.erroredCount++;
    }
    say(`resuming ${resumeId}: ${priorRows.length} rows already scored`);
  }

  // ── Run, checkpointing as we go ───────────────────────────────────────────
  // Written per row rather than at the end. The pattern this clones (novabyte-eval.ts) writes once
  // on completion, which loses a paid run to a sleeping laptop or a Ctrl-C at 90%.
  const rows: Row[] = [];
  let interrupted = false;
  process.on('SIGINT', () => {
    interrupted = true;
    say(`\nInterrupted at ${rows.length}/${questions.length * variants.length}.`);
    say(`Partial rows: ${outPath}`);
    say(`Resume with: bun run eval:rag --dataset ${args.dataset} ${nulls ? '--nulls ' : ''}--resume ${resumeId ?? runId}`);
    process.exit(130);
  });

  const started = Date.now();
  /** Rolling window over the last 10 completions, not a strict streak: with bounded concurrency the
   *  completion order is not the submission order, so "ten in a row" is not a well-defined thing to
   *  count. Ten of the last ten is, and it carries the same signal — an embedding outage does not
   *  fix itself mid-run, and every question after it measures keyword search alone. */
  const recentDegraded: boolean[] = [];
  const totalWork = questions.length * variants.length;
  let aborted: Error | null = null;

  for (const variant of variants) {
    const ctx = await ctxFor(state.principalId, state.workspaces[variant].workspaceId);
    const pending = questions.filter((q) => !done.has(`${variant}:${q.id}`));
    say(`\nscoring ${variant} (${pending.length} questions, concurrency ${CONCURRENCY})…`);

    // Bounded concurrency over a shared cursor, matching the loader. DB_POOL_MAX is 10 and each
    // hybridSearch holds one pooled connection for its transaction, so 4 stays comfortably under it
    // while hiding most of the per-query round trip. Sequential scoring measured ~9s per question on
    // this corpus, which would have made the full sweep an overnight job.
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (interrupted || aborted) return;
        const i = cursor++;
        const q = pending[i];
        if (!q) return;

        const row = nulls ? await abstentionOne(ctx, q, variant) : await scoreOne(ctx, q, variant);
        rows.push(row);
        appendFileSync(outPath, `${JSON.stringify(row)}\n`);

        if (row.degraded) manifest.degradedCount++;
        if (row.error) manifest.erroredCount++;

        // Abort on a sustained error rate for the same reason as the degraded streak: a run that
        // loses a quarter of its rows to timeouts still produces a report, and that report looks
        // clean. Wait for a floor of 40 completions so a couple of early flakes cannot trip it.
        const seen = rows.length + priorRows.length;
        if (seen >= 40 && manifest.erroredCount / seen > 0.05) {
          aborted = new Error(
            `ABORTING: ${manifest.erroredCount} of ${seen} questions (` +
              `${((100 * manifest.erroredCount) / seen).toFixed(1)}%) errored. Errors select against ` +
              `slow, broad queries, so continuing produces a biased sample that reads as a clean ` +
              `result. ${rows.length} rows written to ${outPath}.`,
          );
          return;
        }

        recentDegraded.push(Boolean(row.degraded));
        if (recentDegraded.length > 10) recentDegraded.shift();
        if (recentDegraded.length === 10 && recentDegraded.every(Boolean)) {
          aborted = new Error(
            `ABORTING: the last 10 questions all retrieved with degraded="keyword_only" — the ` +
              `embedding provider is failing, so every number this run produces would measure keyword ` +
              `search only. Check OPENAI_API_KEY and provider status. ${rows.length} rows written to ` +
              `${outPath}; nothing has been reported.`,
          );
          return;
        }

        const n = rows.length + priorRows.length;
        if (n % 100 === 0) {
          const rate = rows.length / Math.max((Date.now() - started) / 1000, 0.001);
          const eta = Math.round((totalWork - n) / Math.max(rate, 0.001));
          say(`  ${n}/${totalWork}  ${rate.toFixed(1)}/s  eta ${Math.floor(eta / 60)}m${eta % 60}s`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
    if (aborted) throw aborted;
  }

  // ── Report ────────────────────────────────────────────────────────────────
  // Prior rows folded back in, so a resumed run reports on the whole set rather than only the part
  // scored after the interruption.
  const allRows = [...priorRows, ...rows];
  const lines: string[] = [];
  lines.push(`# ${args.dataset} eval — ${manifest.startedAt}`, '');

  if (manifest.degradedCount > 0) {
    lines.push(
      `> **WARNING: ${manifest.degradedCount} of ${allRows.length} questions ran keyword-only after an`,
      `> embedding failure. Those rows are EXCLUDED below, and the remaining numbers are not`,
      `> comparable with a clean run.**`,
      '',
    );
  }

  // Errored rows were excluded from every aggregate and reported NOWHERE. A previous run lost 18 of
  // 63 rows (29%) to statement timeouts and printed a clean-looking report — and timeouts are not
  // random, they select against exactly the slow, broad, high-fan-out queries, so the survivors are
  // a biased sample. Say so as loudly as the degraded case.
  if (manifest.erroredCount > 0) {
    const pct = (100 * manifest.erroredCount) / Math.max(allRows.length, 1);
    lines.push(
      `> **WARNING: ${manifest.erroredCount} of ${allRows.length} questions (${pct.toFixed(1)}%) ERRORED`,
      `> and are excluded below. Errors are not random — timeouts select against slow, broad queries —`,
      `> so the remaining rows are a biased sample, not merely a smaller one.**`,
      '',
    );
    const kinds = new Map<string, number>();
    for (const r of allRows) {
      if (!r.error) continue;
      const k = r.error.slice(0, 60);
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
    }
    for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      lines.push(`> - ${n}x \`${k}\``);
    }
    lines.push('');
  }

  lines.push('## Run manifest', '', '```json', JSON.stringify(manifest, null, 2), '```', '');

  if (nulls) {
    lines.push('## Hallucination tier (unanswerable questions)', '');
    lines.push(
      `Produced at topK=${DEFAULT_TOP_K} — \`answerQuestion\` takes no k, so these numbers are NOT`,
      `at the swept cutoffs.`, '',
    );
    for (const variant of variants) {
      const vr = allRows.filter((r) => r.variant === variant && !r.error);
      const count = (v: AbstentionVerdict) => vr.filter((r) => r.abstention === v).length;
      lines.push(`### ${variant}`, '');
      lines.push(table([
        ['verdict', 'count', 'share'],
        ['abstained (clean)', String(count('abstained')), pct(count('abstained') / Math.max(vr.length, 1))],
        ['partial (hedged, then answered)', String(count('partial')), pct(count('partial') / Math.max(vr.length, 1))],
        ['answered (hallucination)', String(count('answered')), pct(count('answered') / Math.max(vr.length, 1))],
      ]), '');
      lines.push(`json_parse_degraded: ${vr.filter((r) => r.jsonParseDegraded).length}`, '');
    }
  } else {
    for (const variant of variants) {
      const agg = aggregate(allRows.filter((r) => r.variant === variant), REPORT_KS);
      lines.push(`## ${variant} — retrieval (${agg.scoredCount} questions scored)`, '');
      lines.push(table([
        ['k', 'all-evidence-recall', 'evidence-recall', 'hit@1', 'MRR', 'distinct docs'],
        ...agg.perK.map((p) => [
          String(p.k), pct(p.allEvidenceRecall), pct(p.evidenceRecall),
          pct(p.hitAt1), p.mrr.toFixed(3), p.distinctDocs.toFixed(1),
        ]),
      ]), '');
      lines.push(`**candidate-recall: ${pct(agg.candidateRecall)}** — share of gold documents present`,
        `anywhere in the ~60-chunk pre-fusion pool. A flat k-curve with HIGH candidate-recall is a`,
        `ranking problem; with LOW candidate-recall it is arm-limit starvation, which is a free`,
        `DB-side fix and no amount of reranking would help.`, '');

      // BY HOP COUNT — the breakdown the diagnosis actually rests on, and the one nothing keyed on
      // before. It separates two failures an aggregate fuses into one number: a bucket that CLIMBS
      // with k is budget-limited (more slots would help), while a bucket that stays FLAT while
      // distinct-docs grows is a coverage failure — the document never enters the pool, and no
      // amount of slot management reaches it. Reading only the aggregate is how a plan ends up
      // prescribing a budget fix for a coverage problem.
      const hops = [...new Set(allRows.filter((r) => r.variant === variant).map((r) => r.goldCount))]
        .filter((n) => n > 0)
        .sort((a, b) => a - b);
      if (hops.length > 1) {
        lines.push(`### ${variant} by hop count — all-evidence-recall, and distinct docs available`, '');
        lines.push(table([
          ['needs', 'n', ...REPORT_KS.map((k) => `@${k}`), `distinct docs @${REPORT_KS[REPORT_KS.length - 1]}`],
          ...hops.map((g) => {
            const sub = allRows.filter((r) => r.variant === variant && r.goldCount === g);
            const a = aggregate(sub, REPORT_KS);
            const last = a.perK[a.perK.length - 1]!;
            return [
              `${g} docs`, String(a.perK[0]?.n ?? 0),
              ...a.perK.map((p) => pct(p.allEvidenceRecall)),
              last.distinctDocs.toFixed(1),
            ];
          }),
        ]), '');
        lines.push(
          `A bucket still climbing at k=${REPORT_KS[REPORT_KS.length - 1]} is budget-limited. A bucket`,
          `flat across every k **while distinct docs exceeds what it needs** is a coverage failure —`,
          `the document is never retrieved, and slot management cannot reach it.`, '');
      }

      // Per-type breakdown: temporal and entity questions fail for different reasons and an
      // aggregate hides that. It is also the evidence path for whether intent weighting is worth it.
      const types = [...new Set(allRows.filter((r) => r.variant === variant).map((r) => r.type))].filter(Boolean);
      if (types.length > 1) {
        lines.push(`### ${variant} by question type (all-evidence-recall)`, '');
        lines.push(table([
          ['type', ...REPORT_KS.map((k) => `@${k}`), 'n'],
          ...types.map((t) => {
            const a = aggregate(allRows.filter((r) => r.variant === variant && r.type === t), REPORT_KS);
            return [t!, ...a.perK.map((p) => pct(p.allEvidenceRecall)), String(a.perK[0]?.n ?? 0)];
          }),
        ]), '');
      }
    }

    if (variants.length === 2) {
      const p = aggregate(allRows.filter((r) => r.variant === 'plain'), REPORT_KS);
      const m = aggregate(allRows.filter((r) => r.variant === 'meta'), REPORT_KS);
      lines.push('## plain vs meta — what the discarded metadata is worth', '');
      lines.push(table([
        ['k', 'plain', 'meta', 'delta'],
        ...REPORT_KS.map((k, i) => {
          const a = p.perK[i]!.allEvidenceRecall, b = m.perK[i]!.allEvidenceRecall;
          return [String(k), pct(a), pct(b), `${b - a >= 0 ? '+' : ''}${((b - a) * 100).toFixed(1)}pp`];
        }),
      ]), '');
      lines.push(
        `The meta workspace prepends \`source | author | published_at\` to each document body, so it`,
        `is searchable/embeddable the way \`pages.title\` is. 92% of questions name an outlet and only`,
        `35% of documents contain their own outlet name in the body. Retrieval never reads \`tags\`.`,
        `A large delta means retrieval depends on CONTENT-MATCHING metadata the engine cannot index`,
        `(since/until/author FILTERING is wired on both variants via provenanceFor() in`,
        `scripts/eval-common.ts and is a separate question from what this delta measures).`, '');
    }
  }

  // Latency: live-only, never replayable, and the reason it is here at all is that a 4.6s regression
  // went unnoticed for exactly as long as nothing measured it.
  const lat = allRows.map((r) => r.latencyMs).filter((n) => n > 0).sort((a, b) => a - b);
  if (lat.length > 0) {
    const q = (p: number) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))]!;
    lines.push('## Retrieval latency', '');
    lines.push(table([
      ['p50', 'p95', 'p99', 'max', 'n'],
      [`${q(0.5)}ms`, `${q(0.95)}ms`, `${q(0.99)}ms`, `${lat[lat.length - 1]}ms`, String(lat.length)],
    ]), '');
    lines.push('_Measured, not replayed. Any config that buys recall with wall clock shows the price here._', '');
  }

  lines.push('---', '',
    '_This corpus is public news, and the model may already know its answers — so retrieval numbers',
    'here are trustworthy and answer-correctness is not measured. A config may not be promoted into',
    'production defaults on this dataset alone: it must also hold on a corpus the model has not seen._', '');

  writeFileSync(mdPath, `${lines.join('\n')}\n`);
  writeFileSync(join(EVAL_DIR, `${args.dataset}-latest.md`), `${lines.join('\n')}\n`);

  say(`\nreport: ${mdPath}`);
  say(`rows:   ${outPath}`);
  if (manifest.degradedCount > 0) {
    say(`\nWARNING: ${manifest.degradedCount} degraded question(s) — the headline numbers exclude them.`);
  }

  await closePools({ timeout: 5 });
}

main().catch(async (err) => {
  say(`\neval failed: ${(err as Error).message}`);
  await closePools({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
