// First-party LongMemEval-S retrieval runner. It deliberately never calls an answer model: every
// reported metric is evidence retrieval over Company Brain's ordinary ingest and RLS-scoped search.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closePools } from '../src/db/client.ts';
import { config } from '../src/config.ts';
import { estimateTokens } from '../src/ingest/chunk.ts';
import { importPage } from '../src/ingest/import.ts';
import { hybridSearch } from '../src/search/hybrid.ts';
import { estimateModelCostUsd } from '../src/core/cycle/budget-meter.ts';
import {
  LONGMEMEVAL_S_CASE_COUNT,
  LONGMEMEVAL_TOP_K,
  assertLongMemEvalBudget,
  assertLongMemEvalResumeIdentity,
  completedLongMemEvalScores,
  longMemEvalSessionSlug,
  normalizeLongMemEval,
  renderLongMemEvalSession,
  sampleLongMemEval,
  scoreLongMemEvalCase,
  summarizeLongMemEval,
  type LongMemEvalCase,
  type LongMemEvalScore,
} from '../src/eval/longmemeval.ts';
import {
  benchmarkContext,
  campaignBudget,
  campaignDir,
  ensureBenchmarkPrincipal,
  ensureBenchmarkWorkspace,
  existingPageSlugs,
  fileExists,
  newCampaignId,
  readJsonFile,
  recordedCampaignSpend,
  requireCleanCompanyBrainProvenance,
  requireBaselineProfile,
  sha256File,
  sha256Json,
  writeImmutableFile,
  writeImmutableJsonFile,
  writeJsonFile,
} from './benchmark-common.ts';

// The published small split downloaded from the link in the benchmark runbook. A different hash
// could be a silently changed corpus, not merely a local rename, so it is a hard stop.
export const LONGMEMEVAL_S_SHA256 = '08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894';

interface CaseState {
  workspaceId: string;
  corpusHash: string;
  sessionSlugById: Record<string, string>;
  score?: LongMemEvalScore;
}

interface LongMemEvalState {
  version: 1;
  campaignId: string;
  sourceSha256: string;
  configurationHash: string;
  selectedQuestionIds: string[];
  principalId: string;
  controllerWorkspaceId: string;
  maxEmbedUsd: number;
  cases: Record<string, CaseState>;
  createdAt: string;
}

interface Args {
  path?: string;
  dryRun: boolean;
  sample?: number;
  sampleSeed: number;
  resume?: string;
  maxEmbedUsd: number;
}

const HELP = `
bun run eval:longmemeval --path /absolute/path/to/longmemeval_s [--dry-run]
  [--sample 25 --sample-seed 42] [--max-embed-usd 10] [--resume <campaign-id>]

Runs Company Brain's default retrieval baseline only: no reranker, query expansion, or retrieval
knob override. Each question gets its own workspace. --dry-run validates all 500 cases and calculates
the campaign estimate without connecting to providers or Postgres.

--resume uses eval/runs/<campaign-id>/state.json and refuses a changed corpus, selected case set,
or retrieval/model configuration. The $10 ceiling is an inclusive campaign ledger, not per case.
`;

function parseArgs(argv: readonly string[]): Args {
  const read = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    if (index === -1) return undefined;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    return value;
  };
  const number = (name: string, fallback: number): number => {
    const raw = read(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`--${name} must be a number, got ${raw}`);
    return value;
  };
  const sampleRaw = read('sample');
  const sample = sampleRaw === undefined ? undefined : Number(sampleRaw);
  if (sample !== undefined && (!Number.isInteger(sample) || sample < 1 || sample > LONGMEMEVAL_S_CASE_COUNT)) {
    throw new Error(`--sample must be an integer from 1 to ${LONGMEMEVAL_S_CASE_COUNT}`);
  }
  const maxEmbedUsd = number('max-embed-usd', 10);
  if (!(maxEmbedUsd > 0) || maxEmbedUsd > 10) throw new Error('--max-embed-usd must be greater than 0 and no more than $10');
  const sampleSeed = number('sample-seed', 42);
  if (!Number.isInteger(sampleSeed)) throw new Error('--sample-seed must be an integer');
  return { path: read('path'), dryRun: argv.includes('--dry-run'), sample, sampleSeed, resume: read('resume'), maxEmbedUsd };
}

function caseHash(item: LongMemEvalCase): string {
  return sha256Json(item);
}

function estimateCaseTokens(item: LongMemEvalCase): number {
  return item.sessions.reduce((total, session) => total + estimateTokens(renderLongMemEvalSession(session)), 0) + estimateTokens(item.question);
}

function manifest(
  campaignId: string,
  sourceSha256: string,
  profile: ReturnType<typeof requireBaselineProfile>,
  selected: readonly LongMemEvalCase[],
  maxEmbedUsd: number,
  state?: LongMemEvalState,
): Record<string, unknown> {
  return {
    benchmark: 'LongMemEval-S',
    benchmark_sha256: sourceSha256,
    expected_sha256: LONGMEMEVAL_S_SHA256,
    company_brain_commit: requireCleanCompanyBrainProvenance().commit,
    campaign_id: campaignId,
    created_at: state?.createdAt ?? new Date().toISOString(),
    retrieval_profile: 'Company Brain default baseline; reranker off; query expansion off; no knob override',
    model: profile.model,
    embedding_dimensions: profile.dimensions,
    retrieval_knob_hash: profile.retrievalKnobHash,
    top_k_chunks: LONGMEMEVAL_TOP_K,
    // A smoke run executes a subset but declares the full 500-question campaign universe. That is
    // what makes a later `--resume <campaign>` full pass share its ledger rather than silently
    // starting a second $10 budget.
    campaign_question_count: state?.selectedQuestionIds.length ?? selected.length,
    executed_question_count: selected.length,
    campaign_question_ids_hash: sha256Json(state?.selectedQuestionIds ?? selected.map((item) => item.questionId)),
    max_embed_usd: maxEmbedUsd,
    controller_workspace_id: state?.controllerWorkspaceId,
    workspace_mapping_hash: state ? sha256Json(Object.fromEntries(Object.entries(state.cases).map(([id, row]) => [id, row.sessionSlugById]))) : undefined,
  };
}

function writeAttemptArtifacts(
  dir: string,
  state: LongMemEvalState,
  allCases: readonly LongMemEvalCase[],
  selected: readonly LongMemEvalCase[],
): void {
  // Artifacts always reconstruct from every durable score, not merely this command's slice. That
  // keeps a smoke-plus-resume campaign honest even if an operator replays a different sample later.
  const rows = completedLongMemEvalScores(
    allCases,
    Object.fromEntries(Object.entries(state.cases).map(([questionId, item]) => [questionId, item.score])),
  );
  const summary = summarizeLongMemEval(rows);
  const attemptDir = join(dir, 'attempts', newCampaignId('receipt'));
  writeImmutableFile(join(attemptDir, 'rows.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
  writeImmutableJsonFile(join(attemptDir, 'summary.json'), summary);
  writeImmutableJsonFile(join(attemptDir, 'receipt.json'), {
    campaign_id: state.campaignId,
    executed_question_ids_hash: sha256Json(selected.map((item) => item.questionId)),
    executed_question_count: selected.length,
    completed_questions: rows.length,
    campaign_question_count: state.selectedQuestionIds.length,
    recorded_at: new Date().toISOString(),
  });
  writeImmutableFile(
    join(attemptDir, 'report.md'),
    `# LongMemEval-S retrieval-only report\n\n` +
      `Campaign: \`${state.campaignId}\`\n\n` +
      `- Denominator: ${summary.denominator}/${state.selectedQuestionIds.length}\n` +
      `- recall_all@5: ${(summary.recall_all_at_5 * 100).toFixed(2)}%\n` +
      `- any-session recall@5: ${(summary.any_session_recall_at_5 * 100).toFixed(2)}%\n` +
      `- evidence recall@5: ${(summary.evidence_recall_at_5 * 100).toFixed(2)}%\n` +
      `- p50 / p95 latency: ${summary.p50_latency_ms}ms / ${summary.p95_latency_ms}ms\n` +
      `- degraded retrievals / failures: ${summary.degraded_retrievals} / ${summary.failures}\n\n` +
      `This is Company Brain default retrieval only; it makes no answer-quality or M10A facts claim.\n`,
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  const args = parseArgs(argv);
  const provenance = requireCleanCompanyBrainProvenance();
  if (!args.path) throw new Error('--path is required');
  if (!fileExists(args.path)) throw new Error(`LongMemEval file does not exist: ${args.path}`);
  const sourceSha256 = sha256File(args.path);
  if (sourceSha256 !== LONGMEMEVAL_S_SHA256) {
    throw new Error(`LongMemEval SHA-256 mismatch: got ${sourceSha256}, expected ${LONGMEMEVAL_S_SHA256}. Nothing was sent to a provider.`);
  }
  const allCases = normalizeLongMemEval(JSON.parse(readFileSync(args.path, 'utf8')), LONGMEMEVAL_S_CASE_COUNT);
  const selected = args.sample === undefined ? allCases : sampleLongMemEval(allCases, args.sample, args.sampleSeed);
  const profile = requireBaselineProfile();
  // Sampling is a run slice, not a retrieval configuration. The campaign identity always covers
  // all 500 validated questions so a 25-question smoke can resume into a full pass.
  const campaignQuestionIds = allCases.map((item) => item.questionId);
  const configurationHash = sha256Json({ profile, topK: LONGMEMEVAL_TOP_K, campaignQuestionIds });
  const campaignId = args.resume ?? newCampaignId('longmemeval');
  const dir = campaignDir(campaignId);
  const statePath = join(dir, 'state.json');

  let previous: LongMemEvalState | undefined;
  if (args.resume) {
    if (!existsSync(statePath)) throw new Error(`cannot resume ${campaignId}: missing ${statePath}`);
    previous = readJsonFile<LongMemEvalState>(statePath);
    if (previous.version !== 1 || previous.campaignId !== campaignId) throw new Error(`cannot resume ${campaignId}: unsupported or mismatched state`);
    assertLongMemEvalResumeIdentity(previous, { sourceSha256, configurationHash, selectedQuestionIds: campaignQuestionIds });
    if (previous.maxEmbedUsd !== args.maxEmbedUsd) throw new Error('resume refused: --max-embed-usd differs from the campaign ledger cap');
  }

  const estimatedInputTokens = selected
    .filter((item) => previous?.cases[item.questionId]?.score === undefined)
    .reduce((total, item) => total + estimateCaseTokens(item), 0);
  const estimatedUsd = estimateModelCostUsd(config.EMBEDDING_MODEL, estimatedInputTokens, 0);
  assertLongMemEvalBudget(estimatedUsd, args.maxEmbedUsd);
  if (args.dryRun) {
    process.stdout.write(`${JSON.stringify({ dry_run: true, cases_validated: allCases.length, cases_selected: selected.length, source_sha256: sourceSha256, estimated_embed_usd: estimatedUsd, company_brain_commit: provenance.commit, manifest: manifest(campaignId, sourceSha256, profile, selected, args.maxEmbedUsd) }, null, 2)}\n`);
    return;
  }

  const principalId = previous?.principalId ?? await ensureBenchmarkPrincipal('longmemeval-eval@example.com');
  const budgetSetup = await campaignBudget(principalId, campaignId, args.maxEmbedUsd, previous?.controllerWorkspaceId);
  // On a resumed campaign the initial estimate is only for unfinished cases. Combine it with the
  // committed ledger before the first new import, otherwise a nearly-spent campaign could discover
  // its breach one provider batch too late.
  const recordedBeforeRun = await recordedCampaignSpend(budgetSetup.ctx, campaignId);
  assertLongMemEvalBudget(recordedBeforeRun + estimatedUsd, args.maxEmbedUsd);
  const state: LongMemEvalState = previous ?? {
    version: 1,
    campaignId,
    sourceSha256,
    configurationHash,
    selectedQuestionIds: campaignQuestionIds,
    principalId,
    controllerWorkspaceId: budgetSetup.controllerWorkspaceId,
    maxEmbedUsd: args.maxEmbedUsd,
    cases: {},
    createdAt: new Date().toISOString(),
  };
  writeJsonFile(statePath, state);
  if (!previous) {
    writeImmutableJsonFile(join(dir, 'manifest.json'), {
      ...manifest(campaignId, sourceSha256, profile, selected, args.maxEmbedUsd, state),
      artifact_type: 'campaign_input_manifest',
    });
  }

  for (const item of selected) {
    const itemHash = caseHash(item);
    let itemState = state.cases[item.questionId];
    if (itemState && itemState.corpusHash !== itemHash) throw new Error(`resume refused: case ${item.questionId} has a different session payload`);
    if (!itemState) {
      const workspaceId = await ensureBenchmarkWorkspace(principalId, `LongMemEval ${campaignId} ${item.questionId}`);
      const sessionSlugById = Object.fromEntries(item.sessionIds.map((sessionId) => [sessionId, longMemEvalSessionSlug(item.questionId, sessionId)]));
      itemState = { workspaceId, corpusHash: itemHash, sessionSlugById };
      state.cases[item.questionId] = itemState;
      writeJsonFile(statePath, state);
    }
    if (itemState.score) continue;
    const ctx = await benchmarkContext(principalId, itemState.workspaceId);
    const alreadyPresent = await existingPageSlugs(ctx);
    for (let index = 0; index < item.sessionIds.length; index++) {
      const sessionId = item.sessionIds[index]!;
      const slug = itemState.sessionSlugById[sessionId]!;
      if (alreadyPresent.has(slug)) continue;
      await importPage(ctx, { slug, title: `LongMemEval session ${sessionId}`, body: renderLongMemEvalSession(item.sessions[index]!), tags: ['eval', 'longmemeval'] }, { budget: budgetSetup.budget });
    }
    const started = Date.now();
    try {
      const outcome = await hybridSearch(ctx, item.question, { topK: LONGMEMEVAL_TOP_K, budget: budgetSetup.budget });
      const sessionBySlug = new Map(Object.entries(itemState.sessionSlugById).map(([sessionId, slug]) => [slug, sessionId]));
      itemState.score = scoreLongMemEvalCase(item, outcome.hits.map((hit) => sessionBySlug.get(hit.slug) ?? `unmapped:${hit.slug}`), {
        latencyMs: Date.now() - started,
        degraded: outcome.degraded !== undefined,
      });
    } catch (err) {
      itemState.score = scoreLongMemEvalCase(item, [], { latencyMs: Date.now() - started, error: (err as Error).message });
    }
    writeJsonFile(statePath, state);
  }

  writeAttemptArtifacts(dir, state, allCases, selected);
  const spend = await recordedCampaignSpend(budgetSetup.ctx, campaignId);
  process.stdout.write(`LongMemEval campaign ${campaignId}: ${Object.values(state.cases).filter((item) => item.score).length}/${selected.length} complete; recorded embedding spend $${spend.toFixed(4)}\n`);
  await closePools({ timeout: 5 });
}

main().catch(async (err) => {
  console.error(`LongMemEval failed: ${(err as Error).message}`);
  await closePools({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
