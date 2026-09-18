// Answer-correctness grading: runs the FULL answer pipeline (real chat calls) on every question a
// dataset ships an `expectedAnswer` for, and grades each answer against that gold text as
// correct / partial / incorrect. No-answer questions are graded too, via the existing abstention
// classifier, so one run and one report cover the whole dataset in one right/wrong/partial vocabulary.
//
// WHY THIS IS A SEPARATE SCRIPT FROM run-rag-eval.ts, NOT A NEW FLAG ON IT. That file's own header
// comment is explicit and deliberate: MultiHop-RAG's answers are public news any 2026 chat model has
// likely memorized, so a "correct" score there could be the model's training data talking, not this
// repo's retrieval — see run-rag-eval.ts's top comment and docs/eval-rag.md's "Which numbers you can
// trust" table. Folding a correctness grader into that script would put a "trust this number"
// affordance next to a dataset it was never meant to be trusted on. A dataset where memorization is
// implausible (mostly obscure blogs/wikis/a private Dropbox doc, per singletopic.ts's own header)
// opts in explicitly by running THIS script instead — nothing here runs unless invoked by name.
//
// SELF-GRADING CAVEAT, undisguised: the judge is FRONTIER_MODEL if set, else CHAT_MODEL — the SAME
// model being graded, because that is the only chat model this repo has configured by default
// (FRONTIER_MODEL is reserved/empty per src/config.ts). A model grading its own answer is a known
// bias (it tends to rate its own hedges generously). The report prints the full gold answer AND the
// full model answer for every row for exactly this reason: the automated verdict is a sorting aid,
// not a verdict to trust blindly on the rows that matter.
import { writeFileSync, appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { closePools, withScopedTx } from '../src/db/client.ts';
import { config } from '../src/config.ts';
import { answerQuestion } from '../src/answer/answer.ts';
import { chat, withRouterScope } from '../src/ai/router.ts';
import { resolveAdapter } from '../src/eval/adapters/index.ts';
import { goldSlugs, stratifiedSample, classifyAbstention, isAbstention, type AbstentionVerdict } from '../src/eval/core.ts';
import type { EvalQuestion } from '../src/eval/types.ts';
import {
  parseArgs, say, ctxFor, loadWorkspaces, knownDatasets, intArg,
  type Variant, type CommonArgs,
} from './eval-common.ts';
import type { OperationContext } from '../src/core/context.ts';

const CONCURRENCY = 4; // Same bound as load-eval-corpus.ts / run-rag-eval.ts — DB_POOL_MAX is 10.
const ANSWER_TRUNCATE = 800; // Report readability; the JSONL checkpoint keeps the full text.

const HELP = `
bun run grade:answers [--dataset <name>] [options]

Runs the FULL answer pipeline (real chat calls) on every question and grades each answer
correct / partial / incorrect against the dataset's own gold answer. No-answer questions are
graded too, via the abstention classifier. See this file's header before trusting a number from it.

  --dataset <name>    Benchmark to run. Default: multihop. Known: ${knownDatasets()}
  --dir <path>        Override the dataset location.
  --variant <v>       Which ingested workspace to answer against. Default: plain.
  --type <t>          Only one question type (single_passage | multi_passage | no_answer).
  --sample <N>        Stratified subset of N questions, proportional across types.
  --sample-seed <N>   Seed for --sample. Default: 42.
  --dry-run           Resolve everything, print the manifest and estimated cost, spend nothing.
  --resume <run-id>   Continue a checkpointed run, skipping questions already graded.
  --help              This text.

SMOKE=1 is an alias for --sample 20.
`;

type Verdict = 'correct' | 'partial' | 'incorrect' | 'unparsed';

interface Row {
  qid: string;
  type: string | null;
  question: string;
  goldAnswer: string | null; // null for no-answer questions — there is nothing to compare to
  modelAnswer: string;
  verdict: Verdict;
  reason: string;
  error: string | null;
  // Retrieval context — null for no-answer questions, which have no gold document to rank.
  goldSlug: string | null;
  rankInContext: number | null; // 1-based position of the gold doc among the chunks the model SAW
  reciprocalRank: number | null;
  citedGold: boolean | null; // did the model's final answer actually cite the gold chunk
  degraded: string | null; // e.g. 'keyword_only' — the embedding provider failed for this question
  latencyMs: number;
}

/** Ask the judge for a strict verdict. Mirrors src/answer/answer.ts's own "parse or degrade
 *  gracefully, never throw" discipline — an unparseable judge response must not silently vanish
 *  into whichever verdict bucket a naive default would pick. */
async function judge(
  workspaceId: string, question: string, gold: string, answer: string,
): Promise<{ verdict: Verdict; reason: string }> {
  const judgeModel = config.FRONTIER_MODEL || config.CHAT_MODEL;
  // answerQuestion wraps ITS OWN chat() call in withRouterScope internally (src/answer/answer.ts),
  // and hybridSearch does the same for embed() — but this judge call is ours, so it needs its own
  // scope the same way, or requireScope() throws "model call made outside withRouterScope".
  const raw = await withRouterScope({ workspaceId, zdr: false }, () =>
    chat({
      model: judgeModel,
      messages: [
        {
          role: 'system',
          content:
            'You grade whether a candidate answer matches a reference (gold) answer to a question. ' +
            'Judge ONLY the factual content against the gold answer — never style, length, or phrasing.\n' +
            '"correct": states the same fact(s) as the gold answer, no material omission or error.\n' +
            '"partial": on-topic, gets part of it right, but omits or gets wrong something material.\n' +
            '"incorrect": contradicts the gold answer, answers a different question, or is a refusal.\n' +
            'Reply with ONLY this JSON and nothing else: {"verdict": "correct"|"partial"|"incorrect", "reason": "<one short sentence>"}',
        },
        { role: 'user', content: `Question: ${question}\n\nGold answer: ${gold}\n\nCandidate answer: ${answer}` },
      ],
    }),
  );
  try {
    const unfenced = raw.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```$/, '');
    const obj = JSON.parse(unfenced) as { verdict?: unknown; reason?: unknown };
    if (obj.verdict === 'correct' || obj.verdict === 'partial' || obj.verdict === 'incorrect') {
      return { verdict: obj.verdict, reason: typeof obj.reason === 'string' ? obj.reason.slice(0, 200) : '' };
    }
  } catch {
    // fall through
  }
  return { verdict: 'unparsed', reason: `judge did not return valid JSON: ${raw.slice(0, 150)}` };
}

async function gradeOne(ctx: OperationContext, q: EvalQuestion): Promise<Row> {
  const base: Omit<Row, 'verdict' | 'reason' | 'error' | 'modelAnswer' | 'latencyMs' | 'degraded'> = {
    qid: q.id, type: q.type ?? null, question: q.text,
    goldAnswer: q.expectedAnswer ?? null,
    goldSlug: null, rankInContext: null, reciprocalRank: null, citedGold: null,
  };
  const started = Date.now();
  try {
    const { answer, citations, cited, sources, degraded } = await answerQuestion(ctx, q.text);
    const latencyMs = Date.now() - started;

    if (q.goldDocIds.length === 0) {
      // Unanswerable: reuse the existing, already-trustworthy abstention classifier rather than
      // spending a second judge call. abstained -> the system did the right thing ("correct");
      // answered -> a hallucination ("incorrect"); partial keeps its own name in both vocabularies.
      const verdict: AbstentionVerdict = classifyAbstention(answer, citations);
      return {
        ...base,
        modelAnswer: answer,
        verdict: verdict === 'abstained' ? 'correct' : verdict === 'answered' ? 'incorrect' : 'partial',
        reason: isAbstention(answer, citations)
          ? 'clean abstention — no answer in the corpus, and the model said so'
          : verdict === 'answered'
            ? 'answered a question the corpus cannot answer (hallucination)'
            : 'hedged, then answered anyway',
        error: null, degraded: degraded ?? null, latencyMs,
      };
    }

    const goldSlug = [...goldSlugs(q)][0]!; // singletopic.ts guarantees exactly one gold doc
    const rank = sources.findIndex((h) => h.slug === goldSlug);
    const { verdict, reason } = await judge(ctx.workspaceId, q.text, q.expectedAnswer ?? '', answer);
    return {
      ...base,
      goldSlug,
      rankInContext: rank === -1 ? null : rank + 1,
      reciprocalRank: rank === -1 ? 0 : 1 / (rank + 1),
      citedGold: cited.some((h) => h.slug === goldSlug),
      modelAnswer: answer,
      verdict, reason, error: null, degraded: degraded ?? null, latencyMs,
    };
  } catch (err) {
    return {
      ...base, modelAnswer: '', verdict: 'unparsed', reason: '', degraded: null,
      error: (err as Error).message, latencyMs: Date.now() - started,
    };
  }
}

function table(rows: string[][]): string {
  const head = rows[0]!;
  const sep = head.map(() => '---');
  return [head, sep, ...rows.slice(1)].map((r) => `| ${r.join(' | ')} |`).join('\n');
}
function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`;
}
function md(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    say(HELP);
    return;
  }

  const args: CommonArgs = parseArgs(argv);
  const adapter = resolveAdapter(args.dataset);
  const { docs, questions: allQuestions } = await adapter.load(args.dir);

  if (!config.CHAT_MODEL && !config.FRONTIER_MODEL) {
    throw new Error('no CHAT_MODEL or FRONTIER_MODEL configured — this script makes real chat calls and needs one.');
  }

  const variant = (args.values.get('variant') as Variant | undefined) ?? 'plain';
  const typeArg = args.values.get('type');
  let questions = typeArg ? allQuestions.filter((q) => q.type === typeArg) : allQuestions;
  if (typeArg && questions.length === 0) {
    const known = [...new Set(allQuestions.map((q) => q.type).filter(Boolean))];
    throw new Error(`--type "${typeArg}" matched nothing. Known types: ${known.join(', ')}`);
  }

  const seed = intArg(args, 'sample-seed', 42);
  const sampleN = process.env.SMOKE === '1' ? 20 : intArg(args, 'sample', 0);
  if (sampleN > 0) questions = stratifiedSample(questions, sampleN, seed);
  if (questions.length === 0) throw new Error('no questions selected');

  const state = loadWorkspaces(args.dataset);
  const ws = state.workspaces[variant];
  const dryRun = args.flags.has('dry-run');

  const ctx = await ctxFor(state.principalId, ws.workspaceId);
  const counts = await withScopedTx(ctx, async (tx) =>
    tx<{ pages: number }[]>`select count(*)::int as pages from pages`);
  const pages = counts[0]?.pages ?? 0;
  if (pages < docs.length && !dryRun) {
    throw new Error(
      `corpus check: ${pages} of ${docs.length} documents in the "${variant}" workspace. ` +
        `Run:  bun run load:eval --dataset ${args.dataset}`,
    );
  }

  const judgeModel = config.FRONTIER_MODEL || config.CHAT_MODEL;
  say(`dataset: ${args.dataset} (${questions.length} question(s), variant "${variant}")`);
  say(`answers: ${config.CHAT_MODEL}  |  judge: ${judgeModel}${config.FRONTIER_MODEL ? '' : ' (SAME model — self-grading, see this file\'s header)'}`);

  if (dryRun) {
    say(`corpus: ${pages} of ${docs.length} pages present`);
    say(`Would make ~${questions.length} answer call(s) + up to ${questions.filter((q) => q.goldDocIds.length > 0).length} judge call(s).`);
    say('Nothing spent. Remove --dry-run to run for real.');
    await closePools({ timeout: 5 });
    return;
  }

  const runsDir = join(process.cwd(), 'eval', 'runs');
  mkdirSync(runsDir, { recursive: true });
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const resumeId = args.values.get('resume');
  const outPath = join(runsDir, `${args.dataset}-grade-${resumeId ?? runId}.jsonl`);
  const mdPath = join(runsDir, `${args.dataset}-grade-${resumeId ?? runId}.md`);

  const done = new Set<string>();
  const priorRows: Row[] = [];
  if (resumeId) {
    if (!existsSync(outPath)) throw new Error(`no checkpoint at ${outPath}`);
    for (const line of readFileSync(outPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as Row;
      done.add(r.qid);
      priorRows.push(r);
    }
    say(`resuming: ${priorRows.length} already graded`);
  }

  let interrupted = false;
  process.on('SIGINT', () => {
    interrupted = true;
    say(`\nInterrupted. Partial rows: ${outPath}`);
    say(`Resume with: bun run grade:answers --dataset ${args.dataset} --resume ${resumeId ?? runId}`);
    process.exit(130);
  });

  const pending = questions.filter((q) => !done.has(q.id));
  const rows: Row[] = [];
  const started = Date.now();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (interrupted) return;
      const i = cursor++;
      const q = pending[i];
      if (!q) return;
      // No withRouterScope wrapper needed here: answerQuestion (via gradeOne) and judge() each
      // establish their own scope internally, right around their own chat()/embed() calls.
      const row = await gradeOne(ctx, q);
      rows.push(row);
      appendFileSync(outPath, `${JSON.stringify(row)}\n`);
      const n = rows.length + priorRows.length;
      if (n % 20 === 0 || n === pending.length + priorRows.length) {
        const rate = rows.length / Math.max((Date.now() - started) / 1000, 0.001);
        say(`  ${n}/${questions.length}  (${rate.toFixed(2)}/s)`);
      }
    }
  };
  say(`\ngrading ${pending.length} question(s), concurrency ${CONCURRENCY}…`);
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));

  // ── Report ──────────────────────────────────────────────────────────────
  const allRows = [...priorRows, ...rows];
  const lines: string[] = [];
  lines.push(`# ${args.dataset} — answer grading — ${new Date().toISOString()}`, '');
  lines.push(
    `Answer model: \`${config.CHAT_MODEL}\`. Judge model: \`${judgeModel}\`` +
      `${config.FRONTIER_MODEL ? '' : ' — **same as the answer model, self-grading** (see grade-answers.ts header)'}.`,
    `Variant: \`${variant}\`. ${allRows.length} question(s) graded.`, '',
  );

  const degraded = allRows.filter((r) => r.degraded);
  if (degraded.length > 0) {
    lines.push(
      `> **WARNING: ${degraded.length} of ${allRows.length} question(s) ran with degraded="${degraded[0]!.degraded}"`,
      `> (the embedding provider failed and retrieval fell back to keyword-only). Their verdicts`,
      `> measure keyword search, not the real pipeline — check OPENAI_API_KEY if this count is large.**`,
      '',
    );
  }

  const errored = allRows.filter((r) => r.error);
  if (errored.length > 0) {
    lines.push(`> **${errored.length} question(s) errored and are excluded below.**`, '');
  }
  const scored = allRows.filter((r) => !r.error);

  lines.push('## Verdicts, overall and by type', '');
  const types = [...new Set(scored.map((r) => r.type ?? '(untyped)'))];
  const verdictRow = (rs: Row[]): string[] => {
    const n = rs.length;
    const c = (v: Verdict) => rs.filter((r) => r.verdict === v).length;
    return [
      String(n), pct(c('correct'), n), pct(c('partial'), n), pct(c('incorrect'), n),
      c('unparsed') > 0 ? String(c('unparsed')) : '-',
    ];
  };
  lines.push(table([
    ['type', 'n', 'correct', 'partial', 'incorrect', 'unparsed'],
    ['ALL', ...verdictRow(scored)],
    ...types.map((t) => [t, ...verdictRow(scored.filter((r) => (r.type ?? '(untyped)') === t))]),
  ]), '');

  const withGold = scored.filter((r) => r.goldSlug);
  if (withGold.length > 0) {
    lines.push('## Retrieval context — did the model actually SEE the right document', '');
    const hit1 = withGold.filter((r) => r.rankInContext === 1).length;
    const inCtx = withGold.filter((r) => r.rankInContext !== null).length;
    const cited = withGold.filter((r) => r.citedGold).length;
    const mrr = withGold.reduce((a, r) => a + (r.reciprocalRank ?? 0), 0) / withGold.length;
    lines.push(table([
      ['n', 'hit@1', 'in context (top 8)', 'cited in final answer', 'MRR'],
      [String(withGold.length), pct(hit1, withGold.length), pct(inCtx, withGold.length), pct(cited, withGold.length), mrr.toFixed(3)],
    ]), '');
    lines.push(
      '`in context` uses the EXACT chunks answerQuestion showed the model (topK=8, no sweep) — this',
      'is what actually explains a wrong answer: if the gold document never made it into context, the',
      'generation step had nothing to work with and a wrong verdict is a RETRIEVAL failure, not a',
      'generation one. Cross-reference with a question\'s row below. For the fuller k=4..20 recall',
      'curve, run `bun run eval:rag --dataset ' + args.dataset + '` (no chat cost).', '',
    );

    // The diagnosis table: for WRONG answers, was the document even available.
    const wrong = withGold.filter((r) => r.verdict === 'incorrect' || r.verdict === 'partial');
    if (wrong.length > 0) {
      const wrongNoContext = wrong.filter((r) => r.rankInContext === null).length;
      lines.push(
        `Of ${wrong.length} wrong/partial answer(s), **${wrongNoContext}** (${pct(wrongNoContext, wrong.length)})`,
        `had the gold document missing from context entirely — a retrieval failure, not a generation`,
        `one. The rest saw the right document and still answered it wrong or incompletely.`, '',
      );
    }
  }

  lines.push('## Every question', '');
  lines.push(table([
    ['id', 'type', 'verdict', 'rank', 'question', 'gold answer', 'model answer', 'judge reason'],
    ...allRows.map((r) => [
      r.qid, r.type ?? '', r.error ? `ERROR: ${md(r.error)}` : r.verdict,
      r.rankInContext === null ? (r.goldSlug ? 'miss' : '-') : String(r.rankInContext),
      md(r.question),
      r.goldAnswer ? md(r.goldAnswer) : '(unanswerable)',
      md(r.modelAnswer.slice(0, ANSWER_TRUNCATE)),
      md(r.reason),
    ]),
  ]), '');

  writeFileSync(mdPath, `${lines.join('\n')}\n`);
  say(`\nreport: ${mdPath}`);
  say(`rows:   ${outPath}`);

  await closePools({ timeout: 5 });
}

main().catch(async (err) => {
  say(`\ngrading failed: ${(err as Error).message}`);
  await closePools({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
