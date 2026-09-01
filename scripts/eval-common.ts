// Shared plumbing for the three eval scripts: argument parsing, the workspace state file, context
// building, and the metadata header that makes the plain-vs-meta A/B possible.
//
// Lives in scripts/ rather than src/eval/ because it does filesystem and database work. src/eval/
// stays pure so test/eval-harness.test.ts can exercise the whole grading surface with no Postgres,
// no network and no money — the same discipline src/search/eval-score.ts keeps.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContext, resolveGrants, type OperationContext } from '../src/core/context.ts';
import { assertMembership } from '../src/auth/membership.ts';
import { resolveAdapter, adapterNames, DEFAULT_DATASET } from '../src/eval/adapters/index.ts';
import type { EvalDocument } from '../src/eval/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, '..');
export const EVAL_DIR = join(REPO_ROOT, 'eval');
/** Gitignored. Holds the workspace ids the seed created, so load and eval never have to trust a
 *  stale shell — see the CB_CLI_* collision note in loadWorkspaces below. */
export const STATE_PATH = join(EVAL_DIR, '.eval-workspaces.json');

/**
 * The two ingest variants.
 *
 * `plain` is what the pipeline does today: body only. `meta` ADDITIONALLY prepends a header carrying
 * source, author and published_at, so it is searchable/embeddable the way `pages.title` is. 92% of
 * MultiHop questions name a news outlet and only 35% of documents contain their own outlet name in
 * the body. Retrieval reads `content_chunks.content`, `content_chunks.embedding` and `pages.title` —
 * never `tags` — so without this header the metadata those questions key on reaches nothing
 * searchable by CONTENT MATCHING, and a low temporal/entity score would be measuring the LOADER, not
 * the pipeline. (`ImportPageInput` gained `author`/`effectiveDate` fields in migration 0014 —
 * `provenanceFor()` below wires them from this SAME metadata bag on BOTH variants, independent of
 * this header, so `since`/`until`/`author` FILTERING works regardless of variant; this header is
 * about ranking/embedding, not filtering.)
 *
 * The delta between the two runs is the finding.
 */
export type Variant = 'plain' | 'meta';
export const VARIANTS: Variant[] = ['plain', 'meta'];

export function workspaceName(dataset: string, variant: Variant): string {
  return `${dataset} eval (${variant})`;
}

/**
 * Render the metadata block for the `meta` variant.
 *
 * `chunkText` has no per-chunk header (that is `chunkBlocks`, which the file path uses), so this
 * lands in chunk 0 only. That is also where the title arm's `ord = 0` chunks come from, so it is
 * reachable by two of the four retrieval arms rather than none.
 */
export function withMetadataHeader(doc: EvalDocument): string {
  const meta = doc.metadata ?? {};
  const parts = Object.entries(meta)
    .filter(([, v]) => typeof v === 'string' && v.trim().length > 0)
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`);
  if (parts.length === 0) return doc.body;
  return `${parts.join(' | ')}\n\n${doc.body}`;
}

export function bodyFor(doc: EvalDocument, variant: Variant): string {
  return variant === 'meta' ? withMetadataHeader(doc) : doc.body;
}

/**
 * Extract the `ingest` op's typed `author`/`effectiveDate` params from an `EvalDocument`'s metadata
 * bag. Independent of `withMetadataHeader` above — that renders the SAME bag into the body text for
 * the `meta`-variant A/B; this feeds the typed columns migration 0014 added, on BOTH variants, so
 * `since`/`until`/`author` search filters have real values to match against on this corpus for the
 * first time. Before this, every loaded page got `author: null` and a defaulted `effectiveDate`
 * regardless of what the dataset said.
 */
export function provenanceFor(doc: EvalDocument): { author?: string; effectiveDate?: string } {
  const meta = doc.metadata ?? {};
  const author = typeof meta.author === 'string' && meta.author.trim() !== '' ? meta.author : undefined;
  // published_at isn't guaranteed to already be a bare YYYY-MM-DD (the ingest op's own zod validator
  // requires exactly that shape) — take the leading date-shaped prefix and drop anything that isn't
  // one, rather than let one malformed dataset row fail a corpus load whose only job is loading.
  const raw = meta.published_at;
  const dateMatch = typeof raw === 'string' ? /^\d{4}-\d{2}-\d{2}/.exec(raw) : null;
  return { author, effectiveDate: dateMatch?.[0] };
}

// ── Workspace state ─────────────────────────────────────────────────────────

export interface WorkspaceRecord {
  workspaceId: string;
  name: string;
}
export interface DatasetState {
  principalId: string;
  seedEmail: string;
  seededAt: string;
  workspaces: Record<Variant, WorkspaceRecord>;
}
export type EvalState = Record<string, DatasetState>;

export function readState(): EvalState {
  if (!existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8')) as EvalState;
  } catch {
    return {};
  }
}

export function writeState(state: EvalState): void {
  mkdirSync(EVAL_DIR, { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Resolve the workspaces for a dataset, from the state file the seed wrote.
 *
 * DELIBERATELY NOT from CB_CLI_WORKSPACE. Those env var names are shared with `load:a17`,
 * `dump:top8`, `ingest-file` and `call`, and `assertMembership` PASSES for the A17 pair because it
 * is a real membership — so a stale shell silently loads 609 news articles into the A17 workspace,
 * which permanently drifts eval/top8-baseline.txt and has no undo (there is no bulk delete anywhere
 * in src/api/operations.ts). Reading the ids the seed actually created removes that whole class.
 */
export function loadWorkspaces(dataset: string): DatasetState {
  const state = readState();
  const entry = state[dataset];
  if (!entry) {
    throw new Error(
      `no seeded workspaces for "${dataset}".\n` +
        `Run:  eval "$(bun run --silent seed:eval --dataset ${dataset})"\n` +
        `(it creates the plain and meta workspaces and records them in ${STATE_PATH})`,
    );
  }
  return entry;
}

export async function ctxFor(principalId: string, workspaceId: string): Promise<OperationContext> {
  // D25: the caller names the pair; the database supplies the authoritative role.
  const role = await assertMembership(principalId, workspaceId);
  return buildContext({
    principal: principalId,
    workspaceId,
    role,
    grants: resolveGrants(principalId, workspaceId),
    remote: false,
  });
}

// ── Arguments ───────────────────────────────────────────────────────────────

export interface CommonArgs {
  dataset: string;
  dir: string;
  flags: Set<string>;
  values: Map<string, string>;
}

/** Minimal flag parser. `--k v`, `--k=v` and bare `--flag` all work; unknown flags are collected
 *  rather than rejected here so each script can validate its own surface and say which it accepts. */
export function parseArgs(argv: readonly string[]): CommonArgs {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) {
      values.set(a.slice(2, eq), a.slice(eq + 1));
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values.set(key, next);
      i++;
    } else {
      flags.add(key);
    }
  }

  const dataset = values.get('dataset') ?? DEFAULT_DATASET;
  // Fail here rather than deeper: a typo'd --dataset should say what to type next, not surface later
  // as a confusing "0 documents found".
  const adapter = resolveAdapter(dataset);
  const dir = values.get('dir') ?? process.env.MULTIHOP_DIR ?? adapter.defaultDir;
  return { dataset, dir, flags, values };
}

export function knownDatasets(): string {
  return adapterNames().join(', ');
}

/** Human-facing output goes to stderr so `eval "$(bun run --silent seed:eval)"` can consume stdout
 *  as pure shell. Every script here follows the same split. */
export function say(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

export function intArg(args: CommonArgs, key: string, fallback: number): number {
  const raw = args.values.get(key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${key} must be a non-negative integer, got "${raw}"`);
  return n;
}
