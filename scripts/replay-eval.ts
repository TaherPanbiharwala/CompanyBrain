// Offline analysis of a banked eval run. No database, no model, no money.
//
// WHAT REPLAY MAY AND MAY NOT ANSWER. Only transforms that are pure functions of the ranked list can
// be replayed: per-page caps, k, fusion re-weighting of an existing list. Anything that changes what
// the DATABASE returns — arm limits, filters, embeddings, chunking — must be run live, and so must
// latency, which is why `latencyMs` is measured per row rather than inferred. Replaying a live-only
// change would produce a confident number for an experiment that never happened.
//
// TWO MODES, because they have different data requirements and different strengths:
//
//   --bound     An ANALYTIC upper bound on maxPerPage=2. Needs only `distinctDocs`, which every row
//               ever written already carries, so it runs against runs banked before this script
//               existed. It cannot be optimistic: it is a bound, not an estimate.
//   --simulate  The EXACT cap-2 result, from the per-chunk `rankedSlugs` added at row schema v2.
//               Sharper, but approximate in one respect (see below) and therefore requires an
//               oracle test against the real engine before its output decides anything.
//
// Run --bound FIRST. If the bound is under the decision threshold, the exact simulation cannot rescue
// the hypothesis — a bound below the bar means every possible outcome is below the bar — and the line
// closes without writing another line of code.
import { readFileSync, existsSync } from 'node:fs';
import { say, parseArgs } from './eval-common.ts';

interface PerK {
  k: number;
  allEvidenceRecall: number | null;
  evidenceRecall: number | null;
  hitAt1: boolean;
  reciprocalRank: number;
  distinctDocs: number;
}
interface Row {
  v?: number;
  qid: string;
  variant: string;
  goldCount: number;
  degraded: string | null;
  error: string | null;
  score: { perK: PerK[]; distinctDocsTotal: number } | null;
  candidateRecall: number | null;
  rankedSlugs?: string[];
  goldSlugs?: string[];
}

const HELP = `
bun run replay-eval --from <run.jsonl> [--variant plain] [--k 8] [--bound] [--simulate] [--cap 2]

Offline analysis of a banked eval run. No database, no model, no cost.

  --from <path>   The .jsonl written by eval:rag. Required.
  --variant <v>   Restrict to one variant. Default: plain (the un-doctored corpus).
  --k <n>         Cutoff to evaluate at. Default: 8 (the production DEFAULT_TOP_K).
  --cap <n>       Per-page cap to model. Default: 2.
  --bound         Analytic upper bound. Works on ANY banked run.
  --simulate      Exact replay. Needs row schema v2 (per-chunk rankedSlugs).
  --help

With neither --bound nor --simulate, runs whichever the data supports.
`;

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}
function pct(x: number): string {
  return `${(100 * x).toFixed(1)}%`;
}
function at(r: Row, k: number): PerK | undefined {
  return r.score?.perK.find((p) => p.k === k);
}

/**
 * Analytic upper bound on `all-evidence-recall@k` under a tighter per-page cap.
 *
 * Under cap `c`, the top-k is the first k of `filter(L, <= c per page)` where `L` is the logged
 * cap-`MAX_PER_PAGE` list. Count the rows the tighter cap removes from the first k:
 *
 *     excess       = k - distinctDocs@k          (how many slots are repeats)
 *     pagesAtCap  <= floor(excess / (M - 1))     (a page holding M chunks eats M-1 of the excess)
 *     d            = pagesAtCap * (M - c)        (each such page loses M-c rows under the new cap)
 *
 * Only pages sitting at the OLD cap can lose anything, and each one costs `M - 1` of the excess to
 * get there — so the excess bounds how many such pages can exist. With M=3, c=2 that is
 * `floor(excess/2)` pages each losing one row, which is materially tighter than bounding `d` by the
 * excess itself. Every document the tighter top-k can contain lies within `L[0 .. k+d-1]`, so
 *
 *     recall(cap=c @k) <= recall(cap=MAX_PER_PAGE @(k+d))
 *
 * and `allEvidenceRecall` is monotone in the document set, so this is a genuine bound rather than an
 * analogy. It is COARSE only because REPORT_KS is sparse — with no k=9 or k=10 the nearest larger
 * cutoff stands in, which can only overstate. A bound that overstates is the safe direction: if it
 * still falls under the threshold, the hypothesis is dead regardless.
 */
function analyticBound(rows: Row[], k: number, cap: number, maxPerPage = 3): {
  baseline: number; bound: number; n: number; meanDistinct: number; ceilingDocs: number;
} {
  const usable = rows.filter((r) => at(r, k)?.allEvidenceRecall !== null && at(r, k) !== undefined);
  const perRow: number[] = [];
  const distinct: number[] = [];
  const ceilings: number[] = [];
  for (const r of usable) {
    const p = at(r, k)!;
    distinct.push(p.distinctDocs);
    const excess = k - p.distinctDocs;
    const pagesAtCap = Math.max(0, Math.floor(excess / Math.max(1, maxPerPage - 1)));
    const d = pagesAtCap * Math.max(0, maxPerPage - cap);
    ceilings.push(p.distinctDocs + d);
    // Nearest available cutoff at or above k+d. Sparse REPORT_KS can only overstate the bound.
    const candidates = r.score!.perK.filter((x) => x.k >= k + d && x.allEvidenceRecall !== null);
    const chosen = candidates.length > 0 ? candidates[0]! : p;
    perRow.push(chosen.allEvidenceRecall!);
  }
  return {
    baseline: mean(usable.map((r) => at(r, k)!.allEvidenceRecall!)),
    bound: mean(perRow),
    n: usable.length,
    meanDistinct: mean(distinct),
    ceilingDocs: mean(ceilings),
  };
}

/** Exact cap-c filter over a per-chunk slug list. Composition makes replaying from a cap-3 log
 *  legitimate: filter(filter(L,<=3),<=2) = filter(L,<=2), since the tighter filter keeps the first
 *  two occurrences and both survive the looser one. */
export function applyCap(ranked: readonly string[], cap: number): string[] {
  const seen = new Map<string, number>();
  const out: string[] = [];
  for (const slug of ranked) {
    const n = seen.get(slug) ?? 0;
    if (n >= cap) continue;
    seen.set(slug, n + 1);
    out.push(slug);
  }
  return out;
}

/** Exact cap-c recall, recomputed from the per-chunk list and the gold set. Both are required: the
 *  ranked list says what a config returns, the gold set says whether that is correct. */
function simulate(
  rows: Row[],
  k: number,
  cap: number,
): { baseline: number; simulated: number; n: number; better: number; worse: number } {
  const base: number[] = [];
  const sim: number[] = [];
  let better = 0;
  let worse = 0;
  for (const r of rows) {
    if (!r.rankedSlugs?.length || !r.goldSlugs?.length) continue;
    const gold = new Set(r.goldSlugs);
    const uncapped = new Set(r.rankedSlugs.slice(0, k));
    const capped = new Set(applyCap(r.rankedSlugs, cap).slice(0, k));
    const b = [...gold].every((s) => uncapped.has(s)) ? 1 : 0;
    const s = [...gold].every((s2) => capped.has(s2)) ? 1 : 0;
    base.push(b);
    sim.push(s);
    if (s > b) better++;
    if (s < b) worse++;
  }
  return { baseline: mean(base), simulated: mean(sim), n: base.length, better, worse };
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    say(HELP);
    return;
  }
  const args = parseArgs(argv);
  const from = args.values.get('from');
  if (!from) throw new Error('--from <run.jsonl> is required. See --help.');
  if (!existsSync(from)) throw new Error(`no such file: ${from}`);

  const variant = args.values.get('variant') ?? 'plain';
  const k = Number(args.values.get('k') ?? 8);
  const cap = Number(args.values.get('cap') ?? 2);

  const all: Row[] = readFileSync(from, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Row);

  // Same exclusions the report applies: a degraded row measured keyword search alone, and an errored
  // row measured nothing. Including them here would make the replay disagree with the report it is
  // meant to reason about.
  const rows = all.filter(
    (r) => r.variant === variant && r.score && !r.degraded && !r.error && r.goldCount > 0,
  );

  say(`${from}`);
  say(`  ${all.length} rows -> ${rows.length} clean, answerable, variant=${variant}`);
  say(`  distinct questions: ${new Set(rows.map((r) => r.qid)).size}`);
  const degraded = all.filter((r) => r.degraded).length;
  const errored = all.filter((r) => r.error).length;
  if (degraded || errored) say(`  EXCLUDED: ${degraded} degraded, ${errored} errored`);
  if (rows.length === 0) throw new Error('no usable rows — check --variant');

  const wantBound = args.flags.has('bound') || !args.flags.has('simulate');
  const hasV2 = rows.some((r) => (r.v ?? 1) >= 2 && r.rankedSlugs);

  if (wantBound) {
    const b = analyticBound(rows, k, cap);
    say('');
    say(`ANALYTIC UPPER BOUND — maxPerPage=${cap} at k=${k} (n=${b.n})`);
    say(`  baseline all-evidence-recall@${k} : ${pct(b.baseline)}`);
    say(`  upper bound                       : ${pct(b.bound)}`);
    say(`  MAX POSSIBLE GAIN                 : ${(100 * (b.bound - b.baseline)).toFixed(1)}pp`);
    say(`  mean distinct docs@${k}            : ${b.meanDistinct.toFixed(2)}  ->  ceiling ${b.ceilingDocs.toFixed(2)}`);
    say('');
    say(`  This is an upper bound, not an estimate: the true gain is lower. A sparse REPORT_KS makes`);
    say(`  it looser still (no k=${k + 1}, so a larger cutoff stands in), which can only overstate.`);
    say(`  If this figure is under your decision threshold, the hypothesis is dead and no exact`);
    say(`  simulation can revive it.`);
  }

  if (args.flags.has('simulate')) {
    if (!hasV2) {
      say('');
      say(`--simulate needs row schema v2 (per-chunk rankedSlugs). This run predates it — the older`);
      say(`rows store only distinct documents, and a per-page cap operates on multiplicity, so the`);
      say(`information required is not recoverable. Re-run eval:rag to bank a v2 log.`);
      return;
    }
    const s = simulate(rows, k, cap);
    say('');
    say(`EXACT SIMULATION — maxPerPage=${cap} at k=${k} (n=${s.n})`);
    say(`  baseline : ${pct(s.baseline)}`);
    say(`  simulated: ${pct(s.simulated)}`);
    say(`  DELTA    : ${(100 * (s.simulated - s.baseline)).toFixed(1)}pp   (${s.better} questions fixed, ${s.worse} broken)`);
    say('');
    say(`  Report the fixed/broken split, not just the net: a config that fixes 30 and breaks 25 is a`);
    say(`  different proposition from one that fixes 5 and breaks 0, and they can net identically.`);
    say('');
    say(`  APPROXIMATE: page_rk is computed over the RRF score while the returned order is the`);
    say(`  0.7*rrf + 0.3*cos blend, so the third occurrence of a page here is not necessarily its`);
    say(`  page_rk = 3. Oracle-test against the real engine before acting on this.`);
  }
}

// `import.meta.main` so the pure helpers above can be imported by test/eval-harness.test.ts without
// the script executing and demanding --from.
if (import.meta.main) {
  try {
    main();
  } catch (err) {
    say(`replay failed: ${(err as Error).message}`);
    process.exit(1);
  }
}
