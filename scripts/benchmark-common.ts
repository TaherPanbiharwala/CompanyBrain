// Shared trusted-server helpers for the M10 benchmark runners. Nothing here is reachable from the
// HTTP/MCP boundary; benchmark credentials and state are intentionally local-only.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminSql, withScopedTx } from '../src/db/client.ts';
import { buildContext, resolveGrants, type OperationContext } from '../src/core/context.ts';
import { assertMembership } from '../src/auth/membership.ts';
import { BudgetMeter, type BudgetMeterOpts } from '../src/core/cycle/budget-meter.ts';
import { config } from '../src/config.ts';
import { retrievalKnobHash } from '../src/search/retrieval-knobs.ts';
import type { RouterBudget } from '../src/ai/router.ts';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const RUNS_DIR = join(SCRIPT_DIR, '..', 'eval', 'runs');

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Atomic replacement prevents a Ctrl-C from leaving a syntactically-valid-but-truncated resume
 * state that would otherwise cause an already-paid case to be ingested again. */
export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

/** Campaign checkpoints are deliberately mutable, but evidence artifacts are not. A later resume
 * must create a new receipt rather than silently replacing the result it is meant to audit. */
export function writeImmutableFile(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  try {
    writeFileSync(path, content, { flag: 'wx' });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new Error(`refusing to overwrite immutable benchmark artifact: ${path}`);
    throw err;
  }
}

export function writeImmutableJsonFile(path: string, value: unknown): void {
  writeImmutableFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function gitOutput(args: readonly string[]): string {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`cannot determine Company Brain provenance: ${new TextDecoder().decode(result.stderr).trim()}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

/** A commit id alone is false provenance when the runner itself is uncommitted. Refuse that state
 * rather than publishing a measurement under the previous commit's identity. */
export function requireCleanCompanyBrainProvenance(): { commit: string } {
  if (gitOutput(['status', '--porcelain=v1', '--untracked-files=all']) !== '') {
    throw new Error('benchmark refuses a dirty Company Brain checkout; commit or discard every change before recording a run');
  }
  return { commit: gitOutput(['rev-parse', 'HEAD']) };
}

export function campaignDir(campaignId: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(campaignId)) throw new Error('campaign id must be a filesystem-safe 1–128 character token');
  return join(RUNS_DIR, campaignId);
}

export function newCampaignId(prefix: string): string {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-').toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`;
}

/** The filesystem/report campaign token is deliberately readable, while M8's transactional
 * ledger requires UUID `run_id` values. Derive a stable UUIDv5-shaped value so resume reads the
 * exact same ledger rows without leaking the display token into a UUID database column. */
export function campaignLedgerRunId(campaignId: string): string {
  const hash = createHash('sha256').update(`company-brain-benchmark-campaign\u0000${campaignId}`).digest('hex');
  const variant = ((Number.parseInt(hash[16]!, 16) & 0b0011) | 0b1000).toString(16);
  const uuid = `${hash.slice(0, 12)}5${hash.slice(13, 16)}${variant}${hash.slice(17, 32)}`;
  return `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`;
}

export function requireBaselineProfile(): { model: string; dimensions: number; retrievalKnobHash: string } {
  if (config.RERANK_MODEL) throw new Error('benchmark refuses RERANK_MODEL: the registered profile is default retrieval with no reranker');
  if (config.QUERY_EXPANSION !== 0) throw new Error('benchmark refuses QUERY_EXPANSION: the registered profile is default retrieval with no query expansion');
  if (config.CB_RETRIEVAL_KNOBS_JSON.trim() !== '') {
    throw new Error('benchmark refuses CB_RETRIEVAL_KNOBS_JSON: retrieval-knob overrides require a distinct campaign');
  }
  if (config.EMBEDDING_MODEL !== 'openai:text-embedding-3-small' || config.EMBEDDING_DIM !== 1536) {
    throw new Error('benchmark requires openai:text-embedding-3-small at 1536 dimensions; use a new registered campaign for another model');
  }
  return { model: config.EMBEDDING_MODEL, dimensions: config.EMBEDDING_DIM, retrievalKnobHash: retrievalKnobHash(config.retrievalKnobs) };
}

export async function ensureBenchmarkPrincipal(email: string): Promise<string> {
  const admin = adminSql();
  const existing = await admin<{ id: string }[]>`select id from principals where email_normalized = ${email}`;
  if (existing[0]) return existing[0].id;
  const inserted = await admin<{ id: string }[]>`
    insert into principals (email, email_normalized) values (${email}, ${email}) returning id`;
  return inserted[0]!.id;
}

export async function ensureBenchmarkWorkspace(principalId: string, name: string): Promise<string> {
  const admin = adminSql();
  const existing = await admin<{ id: string }[]>`
    select w.id from workspaces w join workspace_members m on m.workspace_id = w.id
    where m.principal_id = ${principalId} and w.name = ${name} order by w.id`;
  if (existing.length > 1) throw new Error(`ambiguous benchmark workspace name "${name}" for principal ${principalId}`);
  if (existing[0]) return existing[0].id;
  const inserted = await admin<{ id: string }[]>`
    insert into workspaces (name, created_by) values (${name}, ${principalId}) returning id`;
  const workspaceId = inserted[0]!.id;
  await admin`
    insert into workspace_members (workspace_id, principal_id, role)
    values (${workspaceId}, ${principalId}, 'owner')`;
  return workspaceId;
}

export async function benchmarkContext(principalId: string, workspaceId: string): Promise<OperationContext> {
  const role = await assertMembership(principalId, workspaceId);
  return buildContext({ principal: principalId, workspaceId, role, grants: resolveGrants(principalId, workspaceId), remote: false });
}

export async function existingPageSlugs(ctx: OperationContext): Promise<Set<string>> {
  const rows = await withScopedTx(ctx, async (tx) => tx<{ slug: string }[]>`select slug from pages`);
  return new Set(rows.map((row) => row.slug));
}

export async function campaignBudget(
  principalId: string,
  campaignId: string,
  maxEmbedUsd: number,
  controllerWorkspaceId?: string,
): Promise<{ controllerWorkspaceId: string; ctx: OperationContext; budget: RouterBudget }> {
  const workspaceId = controllerWorkspaceId ?? await ensureBenchmarkWorkspace(principalId, `eval budget ${campaignId}`);
  const ctx = await benchmarkContext(principalId, workspaceId);
  const opts: BudgetMeterOpts = { workspaceId, op: 'benchmark_embedding', runId: campaignLedgerRunId(campaignId), budgetUsd: maxEmbedUsd };
  const meter = new BudgetMeter(ctx, opts);
  return { controllerWorkspaceId: workspaceId, ctx, budget: { check: (estimate) => meter.check(estimate), record: (actual) => meter.record(actual) } };
}

export async function recordedCampaignSpend(ctx: OperationContext, campaignId: string): Promise<number> {
  const ledgerRunId = campaignLedgerRunId(campaignId);
  const [row] = await withScopedTx(ctx, async (tx) => tx<{ spend: string | null }[]>`
    select sum(coalesce(actual_cost_usd, estimated_cost_usd)) as spend
    from cycle_budget_ledger where op = 'benchmark_embedding' and run_id = ${ledgerRunId} and allowed = true`);
  return Number(row?.spend ?? 0);
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}
