// M7 held-out retrieval sweep. MultiHop tuning runs only on the plain workspace; the holdout is
// touched only by baseline and the tuning winner. Rows checkpoint immediately and an immutable
// contract prevents resumes from mixing datasets, splits, clocks, schemas, or policy definitions.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { closePools, withScopedTx } from '../src/db/client.ts';
import { config } from '../src/config.ts';
import { hybridSearch } from '../src/search/hybrid.ts';
import { embed, withRouterScope } from '../src/ai/router.ts';
import { goldSlugs, stratifiedSplit } from '../src/eval/core.ts';
import { resolveAdapter } from '../src/eval/adapters/index.ts';
import type { DatasetBundle, EvalQuestion } from '../src/eval/types.ts';
import { scoreCandidateRecall, scoreMultiHop, type MultiHopScore } from '../src/search/eval-score.ts';
import {
  BOOTSTRAP_RESAMPLES,
  PLANNED_COMPARISONS,
  RETRIEVAL_SWEEP_CONFIGS,
  SWEEP_KS,
  SWEEP_SEED,
  chooseTuningWinner,
  pairedBootstrap,
  stableIdHash,
  sweepConfigManifest,
  type PairedBootstrapResult,
  type TuningSummary,
} from '../src/eval/retrieval-sweep.ts';
import { EVAL_DIR, ctxFor, loadWorkspaces, parseArgs, say } from './eval-common.ts';
import type { QueryIntent } from '../src/search/query-intent.ts';

const ROW_SCHEMA_VERSION = 1;
const CONCURRENCY = 4;
const VARIANT = 'plain' as const;
const TUNING_FRACTION = 0.7;
const POOL_K = 60;

interface SweepContract {
  rowSchemaVersion: number;
  dataset: string;
  datasetHash: string;
  splitSeed: number;
  tuningFraction: number;
  tuningCount: number;
  holdoutCount: number;
  tuningIdHash: string;
  holdoutIdHash: string;
  recencyAsOf: string;
  variant: typeof VARIANT;
  reportKs: readonly number[];
  poolK: number;
  configHashes: Record<string, string>;
  configDefinitionHash: string;
  embeddingModel: string;
  bootstrapResamples: number;
  plannedComparisons: number;
}

interface SweepManifest {
  contract: SweepContract;
  runId: string;
  startedAt: string;
  completedAt?: string;
  winner?: string;
  gate?: PromotionGate;
}

interface SweepRow {
  v: number;
  configName: string;
  knobHash: string;
  split: 'tuning' | 'holdout';
  variant: typeof VARIANT;
  qid: string;
  type: string | null;
  goldCount: number;
  intent: QueryIntent;
  rankedSlugs: string[];
  goldSlugs: string[];
  candidateRecall: number | null;
  score: MultiHopScore | null;
  latencyMs: number;
  degraded: string | null;
  error: string | null;
}

interface CachedQueryVector {
  value: readonly number[];
  /** Charged to every variant so cached evaluation does not understate candidate latency. */
  embeddingLatencyMs: number;
}

interface Aggregate {
  configName: string;
  n: number;
  degraded: number;
  errored: number;
  perK: Array<{ k: number; allEvidenceRecall: number; evidenceRecall: number; mrr: number }>;
  candidateRecall: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
}

interface PromotionGate {
  passed: boolean;
  winner: string;
  overall: PairedBootstrapResult;
  subgroups: Record<string, PairedBootstrapResult>;
  significantRegressions: string[];
  baselineP95LatencyMs: number;
  candidateP95LatencyMs: number;
  latencyRatio: number;
  zeroDegradedAndErrored: boolean;
  fixed: number;
  broken: number;
  reasons: string[];
}

function gitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function datasetHash(bundle: DatasetBundle): string {
  const hash = createHash('sha256');
  const byId = <T extends { id: string }>(a: T, b: T) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  for (const doc of [...bundle.docs].sort(byId)) {
    hash.update(JSON.stringify([doc.id, doc.title, doc.body, doc.metadata ?? {}]));
  }
  for (const question of [...bundle.questions].sort(byId)) {
    hash.update(JSON.stringify([question.id, question.text, question.goldDocIds, question.type ?? null]));
  }
  return hash.digest('hex');
}

function recencyAsOf(bundle: DatasetBundle): string {
  const dates = bundle.docs.map((doc) => doc.metadata?.published_at?.slice(0, 10) ?? '')
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort();
  const maximum = dates.at(-1);
  if (!maximum) throw new Error('dataset has no valid published_at date; cannot freeze recencyAsOf');
  const date = new Date(`${maximum}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]!;
}

function aggregate(configName: string, rows: readonly SweepRow[]): Aggregate {
  const valid = rows.filter((row) => !row.error && !row.degraded && row.score !== null);
  return {
    configName,
    n: valid.length,
    degraded: rows.filter((row) => row.degraded).length,
    errored: rows.filter((row) => row.error).length,
    perK: SWEEP_KS.map((k) => {
      const scores = valid.map((row) => row.score!.perK.find((item) => item.k === k)!);
      return {
        k,
        allEvidenceRecall: mean(scores.map((score) => score.allEvidenceRecall ?? 0)),
        evidenceRecall: mean(scores.map((score) => score.evidenceRecall ?? 0)),
        mrr: mean(scores.map((score) => score.reciprocalRank)),
      };
    }),
    candidateRecall: mean(valid.map((row) => row.candidateRecall ?? 0)),
    p50LatencyMs: percentile(rows.map((row) => row.latencyMs), 0.5),
    p95LatencyMs: percentile(rows.map((row) => row.latencyMs), 0.95),
  };
}

function tuningSummary(rows: readonly SweepRow[], configName: string): TuningSummary {
  const result = aggregate(configName, rows.filter((row) => row.configName === configName));
  const at8 = result.perK.find((metric) => metric.k === 8)!;
  return {
    configName,
    allEvidenceRecallAt8: at8.allEvidenceRecall,
    evidenceRecallAt8: at8.evidenceRecall,
    mrr: at8.mrr,
    p95LatencyMs: result.p95LatencyMs,
  };
}

async function scoreOne(
  context: Awaited<ReturnType<typeof ctxFor>>,
  question: EvalQuestion,
  configName: string,
  split: SweepRow['split'],
  asOf: string,
  queryVectorCache: Map<string, CachedQueryVector>,
): Promise<SweepRow> {
  const knobs = RETRIEVAL_SWEEP_CONFIGS[configName];
  if (!knobs) throw new Error(`unknown retrieval configuration ${configName}`);
  const base: SweepRow = {
    v: ROW_SCHEMA_VERSION,
    configName,
    knobHash: sweepConfigManifest()[configName]!,
    split,
    variant: VARIANT,
    qid: question.id,
    type: question.type ?? null,
    goldCount: question.goldDocIds.length,
    intent: 'general',
    rankedSlugs: [],
    goldSlugs: [...goldSlugs(question)],
    candidateRecall: null,
    score: null,
    latencyMs: 0,
    degraded: null,
    error: null,
  };
  const started = performance.now();
  try {
    let cached = queryVectorCache.get(question.text);
    if (!cached) {
      const embeddingStarted = performance.now();
      const [value] = await withRouterScope(
        { workspaceId: context.workspaceId, zdr: false },
        () => embed([question.text]),
      );
      cached = { value: value!, embeddingLatencyMs: performance.now() - embeddingStarted };
      queryVectorCache.set(question.text, cached);
    }
    const outcome = await hybridSearch(context, question.text, {
      topK: POOL_K,
      knobs,
      recencyAsOf: asOf,
      queryVector: cached.value,
    });
    const rankedSlugs = outcome.hits.map((hit) => hit.slug);
    const gold = goldSlugs(question);
    return {
      ...base,
      intent: outcome.diagnostics.intent,
      rankedSlugs,
      candidateRecall: scoreCandidateRecall(gold, rankedSlugs),
      score: scoreMultiHop(gold, rankedSlugs, SWEEP_KS),
      latencyMs: performance.now() - started + cached.embeddingLatencyMs,
      degraded: outcome.degraded ?? null,
    };
  } catch (error) {
    return { ...base, latencyMs: performance.now() - started, error: (error as Error).message };
  }
}

async function scoreBatch(options: {
  context: Awaited<ReturnType<typeof ctxFor>>;
  questions: readonly EvalQuestion[];
  configName: string;
  split: SweepRow['split'];
  asOf: string;
  rows: SweepRow[];
  done: Set<string>;
  outputPath: string;
  queryVectorCache: Map<string, CachedQueryVector>;
}): Promise<void> {
  const pending = options.questions.filter((question) =>
    !options.done.has(`${options.configName}:${options.split}:${VARIANT}:${question.id}`));
  say(`scoring ${options.split}/${options.configName}: ${pending.length} remaining`);
  const existing = options.rows.filter((row) =>
    row.configName === options.configName && row.split === options.split && row.variant === VARIANT);
  let seen = existing.length;
  let errored = existing.filter((row) => row.error).length;
  const recentDegraded = existing.slice(-10).map((row) => Boolean(row.degraded));
  let aborted: Error | null = null;
  if (recentDegraded.length === 10 && recentDegraded.every(Boolean)) {
    throw new Error(
      `resume refused for ${options.split}/${options.configName}: its last 10 rows are degraded; ` +
        'fix the embedding provider before continuing',
    );
  }
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      if (aborted) return;
      const question = pending[cursor++];
      if (!question) return;
      const row = await scoreOne(
        options.context, question, options.configName, options.split, options.asOf, options.queryVectorCache,
      );
      options.rows.push(row);
      options.done.add(`${row.configName}:${row.split}:${row.variant}:${row.qid}`);
      appendFileSync(options.outputPath, `${JSON.stringify(row)}\n`);
      seen++;
      if (row.error) errored++;
      if (seen >= 40 && errored / seen > 0.05) {
        aborted = new Error(
          `ABORTING ${options.split}/${options.configName}: ${errored}/${seen} rows errored ` +
            `(${((100 * errored) / seen).toFixed(1)}%). Errors select against difficult queries; ` +
            `partial rows remain checkpointed in ${options.outputPath}.`,
        );
        return;
      }
      recentDegraded.push(Boolean(row.degraded));
      if (recentDegraded.length > 10) recentDegraded.shift();
      if (recentDegraded.length === 10 && recentDegraded.every(Boolean)) {
        aborted = new Error(
          `ABORTING ${options.split}/${options.configName}: the last 10 rows are degraded=` +
            `"keyword_only". The embedding provider is failing; partial rows remain checkpointed ` +
            `in ${options.outputPath}.`,
        );
        return;
      }
      if (options.rows.length % 100 === 0) say(`  ${options.rows.length} rows checkpointed`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
  if (aborted) throw aborted;
}

function completeHealthyTuningConfigs(rows: readonly SweepRow[], questions: readonly EvalQuestion[]): string[] {
  const expectedIds = new Set(questions.map((question) => question.id));
  const healthy: string[] = [];
  for (const configName of Object.keys(RETRIEVAL_SWEEP_CONFIGS)) {
    const configRows = rows.filter((row) => row.split === 'tuning' && row.configName === configName);
    const ids = new Set(configRows.map((row) => row.qid));
    if (configRows.length !== questions.length || ids.size !== expectedIds.size ||
        [...expectedIds].some((id) => !ids.has(id))) {
      throw new Error(
        `tuning output incomplete for ${configName}: expected ${questions.length} unique questions, ` +
          `found ${configRows.length} rows/${ids.size} IDs`,
      );
    }
    if (configRows.every((row) => !row.degraded && !row.error && row.score !== null)) healthy.push(configName);
  }
  if (healthy.length === 0) {
    throw new Error('no tuning configuration has a complete, non-degraded, error-free result set');
  }
  return healthy;
}

function at8(row: SweepRow): number {
  return row.score?.perK.find((metric) => metric.k === 8)?.allEvidenceRecall ?? 0;
}

function comparisonGate(rows: readonly SweepRow[], winner: string): PromotionGate {
  const baseline = rows.filter((row) => row.split === 'holdout' && row.configName === 'baseline');
  const candidate = rows.filter((row) => row.split === 'holdout' && row.configName === winner);
  const candidateById = new Map(candidate.map((row) => [row.qid, row]));
  if (baseline.length === 0 || candidate.length !== baseline.length) {
    throw new Error(`holdout comparison is incomplete: baseline=${baseline.length}, candidate=${candidate.length}`);
  }
  const pairs = baseline.map((old) => ({ old, next: candidateById.get(old.qid)! }));
  if (pairs.some((pair) => !pair.next)) throw new Error('holdout comparison has mismatched question IDs');
  const deltas = (selected: typeof pairs) => selected.map(({ old, next }) => at8(next) - at8(old));
  const overall = pairedBootstrap(deltas(pairs));
  const subgroups: Record<string, PairedBootstrapResult> = {};
  const dimensions: Array<[string, (row: SweepRow) => string]> = [
    ['type', (row) => row.type ?? '__untyped__'],
    ['hop', (row) => String(row.goldCount)],
    ['intent', (row) => row.intent],
  ];
  for (const [dimension, keyOf] of dimensions) {
    const keys = [...new Set(baseline.map(keyOf))].sort();
    for (const key of keys) {
      const selected = pairs.filter(({ old }) => keyOf(old) === key);
      if (selected.length > 0) subgroups[`${dimension}:${key}`] = pairedBootstrap(deltas(selected));
    }
  }
  const significantRegressions = Object.entries(subgroups)
    .filter(([, result]) => result.significantRegression).map(([name]) => name);
  const baselineAggregate = aggregate('baseline', baseline);
  const candidateAggregate = aggregate(winner, candidate);
  const latencyRatio = baselineAggregate.p95LatencyMs === 0
    ? Number.POSITIVE_INFINITY
    : candidateAggregate.p95LatencyMs / baselineAggregate.p95LatencyMs;
  const zeroDegradedAndErrored = [...baseline, ...candidate]
    .every((row) => !row.degraded && !row.error);
  const fixed = pairs.filter(({ old, next }) => at8(old) === 0 && at8(next) === 1).length;
  const broken = pairs.filter(({ old, next }) => at8(old) === 1 && at8(next) === 0).length;
  const reasons: string[] = [];
  if (!overall.significantImprovement) reasons.push('overall adjusted confidence interval/p-value gate did not pass');
  if (significantRegressions.length > 0) reasons.push(`significant subgroup regressions: ${significantRegressions.join(', ')}`);
  if (latencyRatio > 1.1) reasons.push(`candidate p95 latency is ${(latencyRatio * 100).toFixed(1)}% of baseline (>110%)`);
  if (!zeroDegradedAndErrored) reasons.push('one or both holdout runs contains degraded or errored rows');
  return {
    passed: reasons.length === 0,
    winner,
    overall,
    subgroups,
    significantRegressions,
    baselineP95LatencyMs: baselineAggregate.p95LatencyMs,
    candidateP95LatencyMs: candidateAggregate.p95LatencyMs,
    latencyRatio,
    zeroDegradedAndErrored,
    fixed,
    broken,
    reasons,
  };
}

function table(rows: string[][]): string {
  return rows.map((row, index) => {
    const line = `| ${row.join(' | ')} |`;
    return index === 0 ? `${line}\n| ${row.map(() => '---').join(' | ')} |` : line;
  }).join('\n');
}

function percent(value: number): string {
  return `${(100 * value).toFixed(2)}%`;
}

function signedMilliseconds(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(0)}`;
}

function fixedBrokenAgainstBaseline(
  rows: readonly SweepRow[],
  configName: string,
): { fixed: number; broken: number } {
  const baseline = new Map(rows
    .filter((row) => row.split === 'tuning' && row.configName === 'baseline')
    .map((row) => [row.qid, row]));
  const candidate = rows.filter((row) => row.split === 'tuning' && row.configName === configName);
  let fixed = 0;
  let broken = 0;
  for (const row of candidate) {
    const previous = baseline.get(row.qid);
    if (!previous) continue;
    if (at8(previous) === 0 && at8(row) === 1) fixed++;
    if (at8(previous) === 1 && at8(row) === 0) broken++;
  }
  return { fixed, broken };
}

function report(manifest: SweepManifest, rows: readonly SweepRow[]): string {
  const lines = [`# M7 retrieval sweep — ${manifest.startedAt}`, '', '## Immutable run contract', '',
    '```json', JSON.stringify(manifest.contract, null, 2), '```', ''];
  const tuningRows = rows.filter((row) => row.split === 'tuning');
  const baselineLatency = aggregate('baseline', tuningRows.filter((row) => row.configName === 'baseline'));
  lines.push('## Tuning results', '');
  lines.push(table([
    ['config', 'all@8', 'evidence@8', 'MRR', 'candidate', 'p50 ms', 'Δp50 ms', 'p95 ms', 'Δp95 ms', 'fixed', 'broken', 'degraded', 'errors'],
    ...Object.keys(RETRIEVAL_SWEEP_CONFIGS).map((name) => {
      const agg = aggregate(name, tuningRows.filter((row) => row.configName === name));
      const at = agg.perK.find((metric) => metric.k === 8)!;
      const changed = fixedBrokenAgainstBaseline(tuningRows, name);
      return [name, percent(at.allEvidenceRecall), percent(at.evidenceRecall), at.mrr.toFixed(4),
        percent(agg.candidateRecall), agg.p50LatencyMs.toFixed(0),
        signedMilliseconds(agg.p50LatencyMs - baselineLatency.p50LatencyMs),
        agg.p95LatencyMs.toFixed(0), signedMilliseconds(agg.p95LatencyMs - baselineLatency.p95LatencyMs),
        String(changed.fixed), String(changed.broken),
        String(agg.degraded), String(agg.errored)];
    }),
  ]), '');
  for (const name of Object.keys(RETRIEVAL_SWEEP_CONFIGS)) {
    const configRows = rows.filter((row) => row.split === 'tuning' && row.configName === name);
    const agg = aggregate(name, configRows);
    lines.push(`### ${name}`, '', table([
      ['k', 'all evidence', 'evidence', 'MRR'],
      ...agg.perK.map((metric) => [String(metric.k), percent(metric.allEvidenceRecall), percent(metric.evidenceRecall), metric.mrr.toFixed(4)]),
    ]), '');
    for (const [label, keyOf] of [
      ['hop', (row: SweepRow) => String(row.goldCount)],
      ['dataset type', (row: SweepRow) => row.type ?? '__untyped__'],
      ['classifier intent', (row: SweepRow) => row.intent],
    ] as const) {
      const keys = [...new Set(configRows.map(keyOf))].sort();
      lines.push(`${label} recall@8: ` + keys.map((key) => {
        const value = mean(configRows.filter((row) => keyOf(row) === key).map(at8));
        return `${key}=${percent(value)}`;
      }).join(', '), '');
    }
  }
  lines.push(`## Holdout gate — ${manifest.gate?.passed ? 'PASS' : 'FAIL'}`, '',
    `Winner: **${manifest.winner ?? '(not selected)'}**`, '', '```json', JSON.stringify(manifest.gate, null, 2), '```', '');
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.dataset !== 'multihop') throw new Error('M7 sweep is preregistered for --dataset multihop only');
  const requestedVariant = args.values.get('variant');
  if (requestedVariant && requestedVariant !== VARIANT) {
    throw new Error(`M7 sweep is preregistered for --variant ${VARIANT} only`);
  }
  const bundle = await resolveAdapter(args.dataset).load(args.dir);
  const answerable = bundle.questions.filter((question) => question.goldDocIds.length > 0);
  const split = stratifiedSplit(answerable, TUNING_FRACTION, SWEEP_SEED);
  const configHashes = sweepConfigManifest();
  const contract: SweepContract = {
    rowSchemaVersion: ROW_SCHEMA_VERSION,
    dataset: args.dataset,
    datasetHash: datasetHash(bundle),
    splitSeed: SWEEP_SEED,
    tuningFraction: TUNING_FRACTION,
    tuningCount: split.tuning.length,
    holdoutCount: split.holdout.length,
    tuningIdHash: stableIdHash(split.tuning.map((question) => question.id)),
    holdoutIdHash: stableIdHash(split.holdout.map((question) => question.id)),
    recencyAsOf: recencyAsOf(bundle),
    variant: VARIANT,
    reportKs: SWEEP_KS,
    poolK: POOL_K,
    configHashes,
    configDefinitionHash: createHash('sha256').update(JSON.stringify(configHashes)).digest('hex'),
    embeddingModel: config.EMBEDDING_MODEL,
    bootstrapResamples: BOOTSTRAP_RESAMPLES,
    plannedComparisons: PLANNED_COMPARISONS,
  };
  const state = loadWorkspaces(args.dataset);
  const workspace = state.workspaces.plain;
  const context = await ctxFor(state.principalId, workspace.workspaceId);
  const [counts] = await withScopedTx(context, (tx) => tx<{ pages: number; chunks: number }[]>`
    select (select count(*)::int from pages) as pages,
           (select count(*)::int from content_chunks) as chunks`);
  const dryRun = args.flags.has('dry-run');
  if (!dryRun && (counts?.pages ?? 0) < bundle.docs.length) {
    throw new Error(`plain eval corpus incomplete: ${counts?.pages ?? 0}/${bundle.docs.length} pages; run bun run load:eval --dataset multihop`);
  }

  const runsDir = join(EVAL_DIR, 'runs');
  mkdirSync(runsDir, { recursive: true });
  const resumeId = args.values.get('resume');
  const runId = resumeId ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-${gitSha()}-m7`;
  const rowPath = join(runsDir, `multihop-${runId}.sweep.jsonl`);
  const manifestPath = join(runsDir, `multihop-${runId}.sweep-manifest.json`);
  const reportPath = join(runsDir, `multihop-${runId}.sweep.md`);
  let manifest: SweepManifest = { contract, runId, startedAt: new Date().toISOString() };
  const rows: SweepRow[] = [];
  const done = new Set<string>();
  if (resumeId) {
    if (!existsSync(manifestPath) || !existsSync(rowPath)) throw new Error(`resume artifacts not found for ${resumeId}`);
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as SweepManifest;
    if (JSON.stringify(manifest.contract) !== JSON.stringify(contract)) {
      throw new Error('resume refused: immutable sweep contract changed (schema/dataset/split/config/knobs/recencyAsOf/model)');
    }
    for (const line of readFileSync(rowPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as SweepRow;
      if (row.v !== ROW_SCHEMA_VERSION || configHashes[row.configName] !== row.knobHash) {
        throw new Error(`resume refused: row schema or knob hash mismatch at ${row.configName}/${row.qid}`);
      }
      rows.push(row);
      done.add(`${row.configName}:${row.split}:${row.variant}:${row.qid}`);
    }
    say(`resuming ${runId}: ${rows.length} rows loaded`);
  } else if (!dryRun) {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  if (dryRun) {
    say(JSON.stringify({ manifest, workspace, pages: counts?.pages, chunks: counts?.chunks }, null, 2));
    await closePools({ timeout: 5 });
    return;
  }

  // The policy variants must receive byte-for-byte identical query vectors. Reusing them avoids
  // redundant provider calls while charging the original embedding duration to each row.
  const queryVectorCache = new Map<string, CachedQueryVector>();

  for (const configName of Object.keys(RETRIEVAL_SWEEP_CONFIGS)) {
    await scoreBatch({ context, questions: split.tuning, configName, split: 'tuning',
      asOf: contract.recencyAsOf, rows, done, outputPath: rowPath, queryVectorCache });
  }
  // A partial or degraded configuration remains in the artifact/report, but it is never eligible to
  // win: aggregate() deliberately excludes bad rows for diagnosis, which would otherwise reward a
  // provider failure by silently shrinking the denominator.
  const eligible = completeHealthyTuningConfigs(rows, split.tuning);
  const summaries = eligible.map((name) => tuningSummary(rows, name));
  const winner = chooseTuningWinner(summaries).configName;
  manifest.winner = winner;
  for (const configName of [...new Set(['baseline', winner])]) {
    await scoreBatch({ context, questions: split.holdout, configName, split: 'holdout',
      asOf: contract.recencyAsOf, rows, done, outputPath: rowPath, queryVectorCache });
  }
  manifest.gate = comparisonGate(rows, winner);
  manifest.completedAt = new Date().toISOString();
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(reportPath, report(manifest, rows));
  writeFileSync(join(EVAL_DIR, 'multihop-m7-latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(EVAL_DIR, 'multihop-m7-latest.md'), report(manifest, rows));
  say(`winner: ${winner}`);
  say(`holdout gate: ${manifest.gate.passed ? 'PASS' : 'FAIL'}${manifest.gate.reasons.length ? ` — ${manifest.gate.reasons.join('; ')}` : ''}`);
  say(`rows: ${rowPath}`);
  say(`report: ${reportPath}`);
  await closePools({ timeout: 5 });
  if (!manifest.gate.passed) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch(async (error) => {
    console.error(error);
    await closePools({ timeout: 5 }).catch(() => undefined);
    process.exit(1);
  });
}
