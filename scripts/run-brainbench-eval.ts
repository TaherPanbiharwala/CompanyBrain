// First-party BrainBench runner. Upstream code is used only as a pinned DATA/query definition; the
// system under test is Company Brain's normal importPage() and hybridSearch(), never gbrain's engine.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { closePools, withScopedTx } from '../src/db/client.ts';
import { estimateTokens } from '../src/ingest/chunk.ts';
import { importPage } from '../src/ingest/import.ts';
import { hybridSearch } from '../src/search/hybrid.ts';
import { runCycle } from '../src/core/cycle.ts';
import { estimateModelCostUsd } from '../src/core/cycle/budget-meter.ts';
import {
  BRAINBENCH_REVISION,
  BRAINBENCH_TOP_K,
  normalizeAmaraManifest,
  normalizeBrainBenchQueries,
  partitionBrainBenchGoldBearingQueries,
  normalizeWorldPages,
  parseAmaraCalendar,
  renderAmaraJsonRecord,
  scoreBrainBenchQuery,
  sha256,
  summarizeBrainBenchRun,
  summarizeBrainBenchRuns,
  worldPageBody,
  type AmaraDocument,
  type AmaraManifestItem,
  type BrainBenchQuery,
  type BrainBenchQueryScore,
  type BrainBenchWorldPage,
} from '../src/eval/brainbench.ts';
import { slugify, findSlugCollisions } from '../src/eval/slug.ts';
import {
  benchmarkContext,
  campaignBudget,
  campaignDir,
  ensureBenchmarkPrincipal,
  ensureBenchmarkWorkspace,
  existingPageSlugs,
  fileExists,
  newCampaignId,
  recordedCampaignSpend,
  requireCleanCompanyBrainProvenance,
  requireBaselineProfile,
  sha256Json,
  writeImmutableFile,
  writeImmutableJsonFile,
} from './benchmark-common.ts';

interface Args {
  checkout?: string;
  dryRun: boolean;
  runFacts: boolean;
  maxEmbedUsd: number;
}

interface CheckoutInfo {
  root: string;
  revision: string;
  corpusHash: string;
}

interface AmaraAudit {
  expected_pages: number;
  ingested_pages: number;
  ingest_failures: Array<{ slug: string; reason: string }>;
  source_hashes: Record<string, { canonical_source_sha256: string; manifest_content_sha256: string }>;
  source_hash_verification: {
    method: 'clean_pinned_eval_data_tree';
    benchmark_data_tree: string;
    verified: true;
  };
  workspace_isolated: boolean;
  provenance_hash: string;
  facts_receipt?: FactExtractionReceipt;
}

interface FactExtractionReceipt {
  run_id: string;
  status: string;
  candidate_pages: number;
  processed_pages: number;
  stamped_pages: number;
  facts_written: number;
  deduplications: number;
  malformed_response_failures: number;
  failures: number;
  ledgered_spend_usd: number;
  budget_usd_cap: 2;
  cycle_report: unknown;
}

interface LoadedWorldQueries {
  queries: BrainBenchQuery[];
  excluded_abstention_query_ids: string[];
}

const HELP = `
bun run eval:brainbench --checkout /absolute/path/to/gbrain-evals [--dry-run] [--run-facts]
  [--max-embed-usd 10]

Requires a complete, clean gbrain-evals checkout at ${BRAINBENCH_REVISION}. A sparse/data-only
checkout is deliberately rejected. world-v1 is a five-seed retrieval scorecard; Amara is an
ingestion/provenance audit. --run-facts runs exactly one fact_extraction cycle only for Amara and
reports its operational receipt, never a retrieval score.
`;

function parseArgs(argv: readonly string[]): Args {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    if (index === -1) return undefined;
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`--${name} requires a value`);
    return next;
  };
  const rawBudget = value('max-embed-usd') ?? '10';
  const maxEmbedUsd = Number(rawBudget);
  if (!Number.isFinite(maxEmbedUsd) || maxEmbedUsd <= 0 || maxEmbedUsd > 10) throw new Error('--max-embed-usd must be a number greater than 0 and no more than $10');
  return { checkout: value('checkout'), dryRun: argv.includes('--dry-run'), runFacts: argv.includes('--run-facts'), maxEmbedUsd };
}

function command(root: string, args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`cannot inspect gbrain-evals checkout: ${new TextDecoder().decode(result.stderr).trim()}`);
  return new TextDecoder().decode(result.stdout).trim();
}

function verifyCheckout(root: string): CheckoutInfo {
  if (!existsSync(root)) throw new Error(`gbrain-evals checkout does not exist: ${root}`);
  const revision = command(root, ['rev-parse', 'HEAD']);
  if (revision !== BRAINBENCH_REVISION) throw new Error(`gbrain-evals is at ${revision}, not required pinned revision ${BRAINBENCH_REVISION}`);
  if (command(root, ['status', '--porcelain']) !== '') throw new Error('gbrain-evals checkout is dirty; reset its local changes or create a clean pinned checkout before benchmarking');
  const sparse = Bun.spawnSync(['git', '-C', root, 'config', '--bool', 'core.sparseCheckout'], { stdout: 'pipe', stderr: 'pipe' });
  if (sparse.exitCode === 0 && new TextDecoder().decode(sparse.stdout).trim() === 'true') {
    throw new Error('gbrain-evals checkout is sparse; use a full pinned checkout before benchmarking');
  }
  const required = [
    'eval/runner/multi-adapter.ts',
    'eval/runner/queries/tier5-fuzzy.ts',
    'eval/runner/queries/tier5_5-synthetic.ts',
    'eval/data/gold/qrels.json',
    'eval/data/world-v1',
    'eval/data/amara-life-v1/corpus-manifest.json',
  ];
  const missing = required.filter((relative) => !existsSync(join(root, relative)));
  if (missing.length > 0) {
    throw new Error(`gbrain-evals checkout is incomplete (often a sparse data-only checkout). Missing: ${missing.join(', ')}`);
  }
  // A commit identity plus the exact tree identity prevents a qrel/corpus pair from being quietly
  // mixed across revisions even where the working tree is clean.
  return { root, revision, corpusHash: command(root, ['rev-parse', `${revision}:eval/data`]) };
}

function shuffled<T>(input: readonly T[], seed: number): T[] {
  let state = seed >>> 0;
  const next = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const copy = [...input];
  for (let index = copy.length - 1; index > 0; index--) {
    const target = Math.floor(next() * (index + 1));
    [copy[index], copy[target]] = [copy[target]!, copy[index]!];
  }
  return copy;
}

function queryArray(raw: unknown, label: string): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    if (Array.isArray(record.queries)) return record.queries;
    const values = Object.values(record);
    if (values.length > 0 && values.every((value) => value && typeof value === 'object' && !Array.isArray(value))) return values;
  }
  throw new Error(`${label} did not contain an exported query array`);
}

async function queriesFromModule(path: string, label: string): Promise<unknown[]> {
  const mod = await import(pathToFileURL(path).href);
  for (const value of Object.values(mod)) {
    if (Array.isArray(value) && value.some((row) => row && typeof row === 'object' && ('id' in row || 'query_id' in row))) return value;
  }
  throw new Error(`${label} module exported no query array; pin a compatible gbrain-evals checkout`);
}

function loadGoldBearingQueries(raw: unknown[], family: string, pageSlugs: ReadonlySet<string>): LoadedWorldQueries {
  const partition = partitionBrainBenchGoldBearingQueries(raw, family);
  return {
    queries: normalizeBrainBenchQueries(partition.candidates, family, pageSlugs),
    excluded_abstention_query_ids: partition.excludedAbstentionQueryIds,
  };
}

async function loadWorldQueries(root: string, pageSlugs: ReadonlySet<string>): Promise<LoadedWorldQueries> {
  const relational = loadGoldBearingQueries(queryArray(JSON.parse(readFileSync(join(root, 'eval/data/gold/qrels.json'), 'utf8')), 'relational qrels'), 'relational', pageSlugs);
  const fuzzy = loadGoldBearingQueries(await queriesFromModule(join(root, 'eval/runner/queries/tier5-fuzzy.ts'), 'tier5-fuzzy'), 'tier5-fuzzy', pageSlugs);
  // At this revision Tier 5.5 is explicitly labelled synthetic-outsider-v1 by upstream. It remains
  // separately identified in reports instead of being misrepresented as an independently published
  // external author set.
  const outsider = loadGoldBearingQueries(await queriesFromModule(join(root, 'eval/runner/queries/tier5_5-synthetic.ts'), 'tier5.5-synthetic-outsider'), 'tier5.5-synthetic-outsider', pageSlugs);
  const ids = new Set<string>();
  for (const query of [...relational.queries, ...fuzzy.queries, ...outsider.queries]) {
    if (ids.has(query.id)) throw new Error(`BrainBench query id ${query.id} appears in multiple families`);
    ids.add(query.id);
  }
  const excluded_abstention_query_ids = [...relational.excluded_abstention_query_ids, ...fuzzy.excluded_abstention_query_ids, ...outsider.excluded_abstention_query_ids];
  if (new Set(excluded_abstention_query_ids).size !== excluded_abstention_query_ids.length) throw new Error('BrainBench abstention query id appears in multiple families');
  return { queries: [...relational.queries, ...fuzzy.queries, ...outsider.queries], excluded_abstention_query_ids };
}

function loadWorldPages(root: string): BrainBenchWorldPage[] {
  const directory = join(root, 'eval/data/world-v1');
  // `_ledger.json` records corpus-generation costs and is not a retrievable public page.
  const entries = readdirSync(directory).filter((name) => name.endsWith('.json') && !name.startsWith('_')).sort();
  if (entries.length === 0) throw new Error('world-v1 contains no page JSON files');
  return normalizeWorldPages(entries.map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8'))));
}

function markdownTitle(body: string, fallback: string): string {
  return /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || fallback;
}

/** Load every manifest item as exactly one page. The clean pinned Git tree verifies the source
 * bytes; per-item receipts retain both the canonical source hash and the manifest's content hash
 * without pretending that differently-defined hashes must be equal. */
function loadAmaraDocuments(root: string): {
  documents: AmaraDocument[];
  manifest: AmaraManifestItem[];
  sourceHashes: Record<string, { canonical_source_sha256: string; manifest_content_sha256: string }>;
} {
  const base = join(root, 'eval/data/amara-life-v1');
  const manifest = normalizeAmaraManifest(JSON.parse(readFileSync(join(base, 'corpus-manifest.json'), 'utf8')));
  const emailRows = new Map<string, unknown>();
  const slackRows = new Map<string, unknown>();
  for (const line of readFileSync(join(base, 'inbox/emails.jsonl'), 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { slug?: string };
    if (!row.slug) throw new Error('email record has no slug');
    if (emailRows.has(row.slug)) throw new Error(`duplicate email record ${row.slug}`);
    emailRows.set(row.slug, row);
  }
  for (const line of readFileSync(join(base, 'slack/messages.jsonl'), 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { slug?: string };
    if (!row.slug) throw new Error('Slack record has no slug');
    if (slackRows.has(row.slug)) throw new Error(`duplicate Slack record ${row.slug}`);
    slackRows.set(row.slug, row);
  }
  const calendar = new Map(parseAmaraCalendar(readFileSync(join(base, 'calendar.ics'), 'utf8')).map((event) => [event.slug, event]));
  const sourceHashes: Record<string, { canonical_source_sha256: string; manifest_content_sha256: string }> = {};
  const recordSourceHash = (item: AmaraManifestItem, canonicalSource: string): string => {
    const canonicalSourceSha256 = sha256(canonicalSource);
    sourceHashes[item.slug] = {
      canonical_source_sha256: canonicalSourceSha256,
      manifest_content_sha256: item.contentSha256,
    };
    return canonicalSourceSha256;
  };
  const documents = manifest.map((item) => {
    if (item.type === 'email') {
      const row = emailRows.get(item.slug);
      if (!row) throw new Error(`manifest email ${item.slug} has no JSONL record`);
      const rendered = renderAmaraJsonRecord(row, 'email');
      return { slug: item.slug, title: rendered.title, body: rendered.body, type: item.type, sourceSha256: recordSourceHash(item, rendered.canonicalSource) };
    }
    if (item.type === 'slack') {
      const row = slackRows.get(item.slug);
      if (!row) throw new Error(`manifest Slack item ${item.slug} has no JSONL record`);
      const rendered = renderAmaraJsonRecord(row, 'slack');
      return { slug: item.slug, title: rendered.title, body: rendered.body, type: item.type, sourceSha256: recordSourceHash(item, rendered.canonicalSource) };
    }
    if (item.type === 'calendar-event') {
      const event = calendar.get(item.slug);
      if (!event) throw new Error(`manifest calendar item ${item.slug} has no VEVENT`);
      return { slug: item.slug, title: event.title, body: event.body, type: item.type, sourceSha256: recordSourceHash(item, event.source) };
    }
    const path = join(base, item.path);
    if (!existsSync(path)) throw new Error(`manifest source ${item.slug} is missing ${item.path}`);
    const body = readFileSync(path, 'utf8');
    const actualHash = sha256(body);
    if (actualHash !== item.contentSha256) throw new Error(`manifest source hash mismatch for ${item.slug}: ${actualHash} != ${item.contentSha256}`);
    return { slug: item.slug, title: markdownTitle(body, item.slug), body, type: item.type, sourceSha256: recordSourceHash(item, body) };
  });
  return { documents, manifest, sourceHashes };
}

function profileManifest(campaignId: string, checkout: CheckoutInfo, maxEmbedUsd: number, companyBrainCommit: string): Record<string, unknown> {
  const profile = requireBaselineProfile();
  return {
    benchmark: 'BrainBench',
    campaign_id: campaignId,
    company_brain_commit: companyBrainCommit,
    benchmark_revision: checkout.revision,
    benchmark_data_tree: checkout.corpusHash,
    model: profile.model,
    embedding_dimensions: profile.dimensions,
    retrieval_knob_hash: profile.retrievalKnobHash,
    top_k_pages: BRAINBENCH_TOP_K,
    native_search_chunk_pool: 20,
    retrieval_profile: 'Company Brain default baseline; reranker off; query expansion off; no knob override',
    max_embed_usd: maxEmbedUsd,
    created_at: new Date().toISOString(),
  };
}

async function ingestPages(
  principalId: string,
  workspaceId: string,
  pages: readonly { sourceSlug: string; title: string; body: string; tags: string[] }[],
  budget: Awaited<ReturnType<typeof campaignBudget>>['budget'],
): Promise<{ sourceBySutSlug: Map<string, string>; failures: Array<{ slug: string; reason: string }> }> {
  const ids = pages.map((page) => page.sourceSlug);
  const collisions = findSlugCollisions(ids);
  if (collisions.size > 0) throw new Error(`Company Brain slug normalisation collision: ${JSON.stringify([...collisions.entries()][0])}`);
  const sourceBySutSlug = new Map(pages.map((page) => [slugify(page.sourceSlug), page.sourceSlug]));
  const ctx = await benchmarkContext(principalId, workspaceId);
  const present = await existingPageSlugs(ctx);
  const failures: Array<{ slug: string; reason: string }> = [];
  for (const page of pages) {
    const slug = slugify(page.sourceSlug);
    if (present.has(slug)) continue;
    try {
      await importPage(ctx, { slug, title: page.title, body: page.body, tags: page.tags }, { budget });
    } catch (err) {
      failures.push({ slug: page.sourceSlug, reason: (err as Error).message });
    }
  }
  return { sourceBySutSlug, failures };
}

async function runWorld(
  campaignId: string,
  principalId: string,
  pages: readonly BrainBenchWorldPage[],
  queries: readonly BrainBenchQuery[],
  budget: Awaited<ReturnType<typeof campaignBudget>>['budget'],
): Promise<{ summaries: ReturnType<typeof summarizeBrainBenchRuns>; rows: Array<BrainBenchQueryScore & { seed: number }>; mappingHashes: string[] }> {
  const summaries = [];
  const rows: Array<BrainBenchQueryScore & { seed: number }> = [];
  const mappingHashes: string[] = [];
  for (let seed = 1; seed <= 5; seed++) {
    const workspaceId = await ensureBenchmarkWorkspace(principalId, `BrainBench ${campaignId} world seed ${seed}`);
    const ingested = await ingestPages(principalId, workspaceId, shuffled(pages, seed).map((page) => ({ sourceSlug: page.slug, title: page.title, body: worldPageBody(page), tags: ['eval', 'brainbench-world'] })), budget);
    if (ingested.failures.length > 0) throw new Error(`world-v1 seed ${seed} had ${ingested.failures.length} ingest failures; refusing a partial scorecard`);
    mappingHashes.push(sha256Json([...ingested.sourceBySutSlug.entries()].sort()));
    const ctx = await benchmarkContext(principalId, workspaceId);
    const scores: BrainBenchQueryScore[] = [];
    for (const query of queries) {
      const started = Date.now();
      try {
        const outcome = await hybridSearch(ctx, query.text, { topK: 20, budget });
        const sourceRanked = outcome.hits.map((hit) => ingested.sourceBySutSlug.get(hit.slug) ?? `unmapped:${hit.slug}`);
        scores.push(scoreBrainBenchQuery(query, sourceRanked, { latencyMs: Date.now() - started, degraded: outcome.degraded !== undefined }));
      } catch (err) {
        scores.push(scoreBrainBenchQuery(query, [], { latencyMs: Date.now() - started, error: (err as Error).message }));
      }
    }
    summaries.push(summarizeBrainBenchRun(scores));
    rows.push(...scores.map((score) => ({ ...score, seed })));
  }
  return { summaries: summarizeBrainBenchRuns(summaries), rows, mappingHashes };
}

async function auditAmara(
  campaignId: string,
  principalId: string,
  documents: readonly AmaraDocument[],
  sourceHashes: Record<string, { canonical_source_sha256: string; manifest_content_sha256: string }>,
  benchmarkDataTree: string,
  budget: Awaited<ReturnType<typeof campaignBudget>>['budget'],
  runFacts: boolean,
): Promise<AmaraAudit> {
  const workspaceId = await ensureBenchmarkWorkspace(principalId, `BrainBench ${campaignId} Amara`);
  const ingested = await ingestPages(principalId, workspaceId, documents.map((doc) => ({ sourceSlug: doc.slug, title: doc.title, body: doc.body, tags: ['eval', 'brainbench-amara', doc.type] })), budget);
  const ctx = await benchmarkContext(principalId, workspaceId);
  const [count] = await withScopedTx(ctx, async (tx) => tx<{ count: string }[]>`select count(*) as count from pages where tags @> ${['brainbench-amara']}::text[]`);
  const probePrincipal = await ensureBenchmarkPrincipal(`brainbench-amara-probe-${campaignId}@example.com`);
  const probeWorkspace = await ensureBenchmarkWorkspace(probePrincipal, `BrainBench probe ${campaignId}`);
  const probeCtx = await benchmarkContext(probePrincipal, probeWorkspace);
  const [probeCount] = await withScopedTx(probeCtx, async (tx) => tx<{ count: string }[]>`select count(*) as count from pages where tags @> ${['brainbench-amara']}::text[]`);
  const audit: AmaraAudit = {
    expected_pages: documents.length,
    ingested_pages: Number(count?.count ?? 0),
    ingest_failures: ingested.failures,
    source_hashes: sourceHashes,
    source_hash_verification: {
      method: 'clean_pinned_eval_data_tree',
      benchmark_data_tree: benchmarkDataTree,
      verified: true,
    },
    workspace_isolated: Number(probeCount?.count ?? 0) === 0,
    provenance_hash: sha256Json(documents.map((doc) => ({ slug: doc.slug, source_sha256: doc.sourceSha256 }))),
  };
  if (runFacts) {
    // M10A owns its $2 fact cap. We do not pass a larger budget override and do not run it on world
    // or LongMemEval workspaces.
    const cycleReport = await runCycle({ workspaceId, phases: ['fact_extraction'] });
    const phase = cycleReport.phases.find((result) => result.phase === 'fact_extraction');
    const details = phase?.details ?? {};
    const numberDetail = (key: string): number => {
      const value = details[key];
      return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    };
    const [stamped] = await withScopedTx(ctx, (tx) => tx<{ count: string }[]>`
      select count(*) as count from pages
      where tags @> ${['brainbench-amara']}::text[]
        and content_hash is not null
        and content_hash = facts_extracted_content_hash`);
    const [malformed] = await withScopedTx(ctx, (tx) => tx<{ count: string }[]>`
      select count(*) as count from cycle_failures
      where op = 'fact_extraction'
        and error_message = 'fact extraction response could not be parsed as JSON'`);
    const [spend] = await withScopedTx(ctx, (tx) => tx<{ spend: string | null }[]>`
      select sum(coalesce(actual_cost_usd, estimated_cost_usd)) as spend
      from cycle_budget_ledger
      where op = 'fact_extraction' and run_id = ${cycleReport.run_id} and allowed = true`);
    audit.facts_receipt = {
      run_id: cycleReport.run_id,
      status: cycleReport.status,
      candidate_pages: numberDetail('pages_scanned'),
      processed_pages: numberDetail('pages_processed'),
      stamped_pages: Number(stamped?.count ?? 0),
      facts_written: numberDetail('facts_written'),
      deduplications: numberDetail('duplicates_found'),
      malformed_response_failures: Number(malformed?.count ?? 0),
      failures: numberDetail('failures'),
      ledgered_spend_usd: Number(spend?.spend ?? 0),
      budget_usd_cap: 2,
      cycle_report: cycleReport,
    };
  }
  return audit;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  const args = parseArgs(argv);
  const provenance = requireCleanCompanyBrainProvenance();
  if (!args.checkout || !fileExists(args.checkout)) throw new Error('--checkout must name a complete local gbrain-evals checkout');
  const checkout = verifyCheckout(args.checkout);
  const pages = loadWorldPages(checkout.root);
  const loadedQueries = await loadWorldQueries(checkout.root, new Set(pages.map((page) => page.slug)));
  const queries = loadedQueries.queries;
  const amara = loadAmaraDocuments(checkout.root);
  const profile = requireBaselineProfile();
  const estimatedTokens = 5 * (pages.reduce((sum, page) => sum + estimateTokens(worldPageBody(page)), 0) + queries.reduce((sum, query) => sum + estimateTokens(query.text), 0)) + amara.documents.reduce((sum, doc) => sum + estimateTokens(doc.body), 0);
  const estimatedUsd = estimateModelCostUsd(profile.model, estimatedTokens, 0);
  if (estimatedUsd > args.maxEmbedUsd) throw new Error(`preflight refuses this BrainBench campaign: estimated embedding cost $${estimatedUsd.toFixed(4)} exceeds cap $${args.maxEmbedUsd.toFixed(4)}`);
  if (args.dryRun) {
    process.stdout.write(`${JSON.stringify({ dry_run: true, checkout, world_pages: pages.length, world_queries: queries.length, excluded_abstention_query_ids: loadedQueries.excluded_abstention_query_ids, amara_pages: amara.documents.length, estimated_embed_usd: estimatedUsd, manifest: profileManifest('dry-run', checkout, args.maxEmbedUsd, provenance.commit), model: profile.model }, null, 2)}\n`);
    return;
  }
  const campaignId = newCampaignId('brainbench');
  const dir = campaignDir(campaignId);
  const principalId = await ensureBenchmarkPrincipal('brainbench-eval@example.com');
  const budgetSetup = await campaignBudget(principalId, campaignId, args.maxEmbedUsd);
  writeImmutableJsonFile(join(dir, 'manifest.json'), {
    ...profileManifest(campaignId, checkout, args.maxEmbedUsd, provenance.commit),
    artifact_type: 'campaign_input_manifest',
    controller_workspace_id: budgetSetup.controllerWorkspaceId,
    world_page_count: pages.length,
    query_count: queries.length,
    excluded_abstention_query_ids: loadedQueries.excluded_abstention_query_ids,
    amara_page_count: amara.documents.length,
  });
  const world = await runWorld(campaignId, principalId, pages, queries, budgetSetup.budget);
  const amaraAudit = await auditAmara(campaignId, principalId, amara.documents, amara.sourceHashes, checkout.corpusHash, budgetSetup.budget, args.runFacts);
  if (amaraAudit.ingested_pages !== amaraAudit.expected_pages || amaraAudit.ingest_failures.length > 0 || !amaraAudit.workspace_isolated) {
    throw new Error('Amara audit failed: expected page count, ingest success, or RLS isolation did not hold');
  }
  writeImmutableFile(join(dir, 'world-rows.jsonl'), world.rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  writeImmutableJsonFile(join(dir, 'world-summary.json'), world.summaries);
  writeImmutableJsonFile(join(dir, 'amara-audit.json'), amaraAudit);
  const spend = await recordedCampaignSpend(budgetSetup.ctx, campaignId);
  writeImmutableJsonFile(join(dir, 'receipt.json'), {
    ...profileManifest(campaignId, checkout, args.maxEmbedUsd, provenance.commit),
    controller_workspace_id: budgetSetup.controllerWorkspaceId,
    world_page_count: pages.length,
    query_count: queries.length,
    amara_page_count: amara.documents.length,
    world_workspace_mapping_hashes: world.mappingHashes,
    amara_provenance_hash: amaraAudit.provenance_hash,
    recorded_embedding_spend_usd: spend,
    completed_at: new Date().toISOString(),
  });
  writeImmutableFile(join(dir, 'report.md'), `# BrainBench Company Brain report\n\n- world-v1 page retrieval: five seeded upload-order runs\n- P@5: ${(world.summaries.precision_at_5.mean * 100).toFixed(2)}% ± ${(world.summaries.precision_at_5.stddev * 100).toFixed(2)}%\n- R@5: ${(world.summaries.recall_at_5.mean * 100).toFixed(2)}% ± ${(world.summaries.recall_at_5.stddev * 100).toFixed(2)}%\n- MRR: ${world.summaries.mrr.mean.toFixed(4)} ± ${world.summaries.mrr.stddev.toFixed(4)}\n- p50 / p95 query latency: ${world.summaries.p50_latency_ms.mean.toFixed(1)}ms / ${world.summaries.p95_latency_ms.mean.toFixed(1)}ms\n- errors / degraded retrievals: ${world.summaries.errors.mean.toFixed(2)} / ${world.summaries.degraded_retrievals.mean.toFixed(2)}\n- abstention queries excluded from retrieval denominator: ${loadedQueries.excluded_abstention_query_ids.length}\n- Amara ingestion audit: ${amaraAudit.ingested_pages}/${amaraAudit.expected_pages} pages; RLS isolated: ${amaraAudit.workspace_isolated}\n- Recorded embedding spend: $${spend.toFixed(4)}\n\nAmara facts receipt, when requested, is an M10A operational audit and is not retrieval-impact evidence.\n`);
  process.stdout.write(`BrainBench campaign ${campaignId} complete; artifacts: ${dir}\n`);
  await closePools({ timeout: 5 });
}

main().catch(async (err) => {
  console.error(`BrainBench failed: ${(err as Error).message}`);
  await closePools({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
