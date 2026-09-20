// Pure BrainBench adapters and scorers. In particular, `_facts` is intentionally not represented
// in the ingestion shape: it may be read to build/validate qrels but cannot accidentally become SUT
// page text by flowing through a shared `Record<string, unknown>`.
import { createHash } from 'node:crypto';

export const BRAINBENCH_REVISION = '9238ec8456bc94c3c082db105d7d8169a10a0b0f';
export const BRAINBENCH_TOP_K = 5;

export interface BrainBenchWorldPage {
  slug: string;
  title: string;
  compiledTruth: string;
  timeline: string;
}

export interface BrainBenchQuery {
  id: string;
  family: string;
  text: string;
  relevantSlugs: string[];
}

export interface BrainBenchGoldBearingPartition {
  candidates: unknown[];
  excludedAbstentionQueryIds: string[];
}

export interface BrainBenchQueryScore {
  id: string;
  family: string;
  precisionAt5: number;
  recallAt5: number;
  reciprocalRank: number;
  latencyMs: number;
  degraded: boolean;
  error?: string;
  rankedSlugs: string[];
}

export interface BrainBenchRunSummary {
  denominator: number;
  precision_at_5: number;
  recall_at_5: number;
  mrr: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  errors: number;
  degraded_retrievals: number;
}

export interface MeanStddev {
  mean: number;
  stddev: number;
}

export interface BrainBenchFiveRunSummary {
  runs: BrainBenchRunSummary[];
  precision_at_5: MeanStddev;
  recall_at_5: MeanStddev;
  mrr: MeanStddev;
  p50_latency_ms: MeanStddev;
  p95_latency_ms: MeanStddev;
  errors: MeanStddev;
  degraded_retrievals: MeanStddev;
}

export interface AmaraManifestItem {
  slug: string;
  path: string;
  type: string;
  contentSha256: string;
}

export interface AmaraDocument {
  slug: string;
  title: string;
  body: string;
  type: string;
  sourceSha256: string;
}

type RecordValue = Record<string, unknown>;

function record(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as RecordValue;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`);
  return value;
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((x) => typeof x !== 'string' || x.trim() === '')) {
    throw new Error(`${label} must be a non-empty array of strings`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} has duplicate slugs`);
  return [...value] as string[];
}

/** Extract exactly the searchable public fields. It does not spread the raw object, so `_facts`
 * cannot be put into the Company Brain input by a later call-site refactor. */
export function normalizeWorldPage(raw: unknown, label = 'world page'): BrainBenchWorldPage {
  const value = record(raw, label);
  const rawTimeline = value.timeline;
  const timeline = typeof rawTimeline === 'string'
    ? rawTimeline
    : Array.isArray(rawTimeline) && rawTimeline.every((entry) => typeof entry === 'string')
      ? rawTimeline.join('\n')
      : (() => { throw new Error(`${label}.timeline must be a string or array of strings`); })();
  return {
    slug: nonEmpty(value.slug, `${label}.slug`),
    title: nonEmpty(value.title, `${label}.title`),
    compiledTruth: nonEmpty(value.compiled_truth, `${label}.compiled_truth`),
    timeline,
  };
}

export function normalizeWorldPages(raw: unknown): BrainBenchWorldPage[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('world-v1 corpus must be a non-empty JSON array');
  const pages = raw.map((row, index) => normalizeWorldPage(row, `world page[${index}]`));
  const slugs = new Set<string>();
  for (const page of pages) {
    if (slugs.has(page.slug)) throw new Error(`world-v1 corpus has duplicate page slug ${page.slug}`);
    slugs.add(page.slug);
  }
  return pages;
}

export function worldPageBody(page: BrainBenchWorldPage): string {
  return `${page.title}\n\n${page.compiledTruth}\n\n${page.timeline}`.trim();
}

/** Accept the two published qrel field spellings without weakening validation. The runner separately
 * excludes only explicit abstention cases, which have no retrieval qrels by definition. */
export function normalizeBrainBenchQueries(
  raw: unknown,
  family: string,
  publicPageSlugs: ReadonlySet<string>,
): BrainBenchQuery[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${family} queries must be a non-empty array`);
  const ids = new Set<string>();
  return raw.map((candidate, index) => {
    const value = record(candidate, `${family}[${index}]`);
    const id = nonEmpty(value.id ?? value.query_id, `${family}[${index}].id`);
    if (ids.has(id)) throw new Error(`${family} has duplicate query id ${id}`);
    ids.add(id);
    const text = nonEmpty(value.question ?? value.text ?? value.query, `${family}[${index}].question`);
    const goldRecord = value.gold && typeof value.gold === 'object' && !Array.isArray(value.gold) ? (value.gold as RecordValue) : undefined;
    const relevant = stringList(
      value.relevant ?? value.relevantSlugs ?? value.relevant_slugs ?? goldRecord?.relevant ?? goldRecord?.relevant_slugs,
      `${family}[${index}].gold.relevant`,
    );
    for (const slug of relevant) {
      if (!publicPageSlugs.has(slug)) throw new Error(`${family} query ${id} names unknown public page ${slug}`);
    }
    return { id, family, text, relevantSlugs: relevant };
  });
}

/** Abstention rows deliberately have no retrieval qrels and therefore cannot belong in a page
 * retrieval denominator. They are excluded only when the upstream marks them explicitly; every
 * other malformed or unlabeled query remains a hard preflight error in normalizeBrainBenchQueries. */
export function partitionBrainBenchGoldBearingQueries(raw: unknown, family: string): BrainBenchGoldBearingPartition {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${family} queries must be a non-empty array`);
  const candidates: unknown[] = [];
  const excludedAbstentionQueryIds: string[] = [];
  for (let index = 0; index < raw.length; index++) {
    const value = record(raw[index], `${family}[${index}]`);
    const goldRecord = value.gold && typeof value.gold === 'object' && !Array.isArray(value.gold) ? (value.gold as RecordValue) : undefined;
    if (goldRecord?.expected_abstention !== true && value.expected_abstention !== true) {
      candidates.push(raw[index]);
      continue;
    }
    const id = nonEmpty(value.id ?? value.query_id, `${family}[${index}].id`);
    const relevant = value.relevant ?? value.relevantSlugs ?? value.relevant_slugs ?? goldRecord?.relevant ?? goldRecord?.relevant_slugs;
    if (relevant !== undefined && (!Array.isArray(relevant) || relevant.length > 0)) {
      throw new Error(`BrainBench abstention query ${id} unexpectedly has retrieval qrels`);
    }
    excludedAbstentionQueryIds.push(id);
  }
  if (new Set(excludedAbstentionQueryIds).size !== excludedAbstentionQueryIds.length) {
    throw new Error(`${family} has duplicate abstention query ids`);
  }
  return { candidates, excludedAbstentionQueryIds };
}

/** Convert a native chunk result list to page ranking, retaining the first appearance of each page.
 * This is the declared adapter boundary for a page-level upstream scorecard. */
export function firstPageOccurrences(rankedChunkSlugs: readonly string[], topK = BRAINBENCH_TOP_K): string[] {
  const pages: string[] = [];
  const seen = new Set<string>();
  for (const slug of rankedChunkSlugs) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    pages.push(slug);
    if (pages.length === topK) break;
  }
  return pages;
}

export function scoreBrainBenchQuery(
  query: BrainBenchQuery,
  rankedChunkSlugs: readonly string[],
  opts: { latencyMs: number; degraded?: boolean; error?: string },
): BrainBenchQueryScore {
  const rankedSlugs = firstPageOccurrences(rankedChunkSlugs);
  const relevant = new Set(query.relevantSlugs);
  const matching = rankedSlugs.filter((slug) => relevant.has(slug));
  const first = rankedSlugs.findIndex((slug) => relevant.has(slug));
  return {
    id: query.id,
    family: query.family,
    // P@5 uses five slots even if a retrieval error or an underfilled result set returns fewer.
    precisionAt5: matching.length / BRAINBENCH_TOP_K,
    recallAt5: matching.length / relevant.size,
    reciprocalRank: first === -1 ? 0 : 1 / (first + 1),
    latencyMs: opts.latencyMs,
    degraded: opts.degraded ?? false,
    error: opts.error,
    rankedSlugs,
  };
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)]!;
}

export function summarizeBrainBenchRun(scores: readonly BrainBenchQueryScore[]): BrainBenchRunSummary {
  const n = scores.length || 1;
  return {
    denominator: scores.length,
    precision_at_5: scores.reduce((sum, score) => sum + score.precisionAt5, 0) / n,
    recall_at_5: scores.reduce((sum, score) => sum + score.recallAt5, 0) / n,
    mrr: scores.reduce((sum, score) => sum + score.reciprocalRank, 0) / n,
    p50_latency_ms: percentile(scores.map((score) => score.latencyMs), 0.5),
    p95_latency_ms: percentile(scores.map((score) => score.latencyMs), 0.95),
    errors: scores.filter((score) => score.error !== undefined).length,
    degraded_retrievals: scores.filter((score) => score.degraded).length,
  };
}

function meanStddev(values: readonly number[]): MeanStddev {
  if (values.length === 0) return { mean: 0, stddev: 0 };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const stddev = values.length < 2 ? 0 : Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
  return { mean, stddev };
}

export function summarizeBrainBenchRuns(runs: readonly BrainBenchRunSummary[]): BrainBenchFiveRunSummary {
  if (runs.length !== 5) throw new Error(`BrainBench requires exactly five seeded upload-order runs, got ${runs.length}`);
  const metric = <K extends keyof BrainBenchRunSummary>(key: K) => meanStddev(runs.map((run) => run[key] as number));
  return {
    runs: [...runs],
    precision_at_5: metric('precision_at_5'),
    recall_at_5: metric('recall_at_5'),
    mrr: metric('mrr'),
    p50_latency_ms: metric('p50_latency_ms'),
    p95_latency_ms: metric('p95_latency_ms'),
    errors: metric('errors'),
    degraded_retrievals: metric('degraded_retrievals'),
  };
}

export function normalizeAmaraManifest(raw: unknown): AmaraManifestItem[] {
  const value = record(raw, 'Amara manifest');
  if (!Array.isArray(value.items) || value.items.length === 0) throw new Error('Amara manifest.items must be a non-empty array');
  const slugs = new Set<string>();
  return value.items.map((item, index) => {
    const row = record(item, `Amara manifest.items[${index}]`);
    const normalized = {
      slug: nonEmpty(row.slug, `Amara manifest.items[${index}].slug`),
      path: nonEmpty(row.path, `Amara manifest.items[${index}].path`),
      type: nonEmpty(row.type, `Amara manifest.items[${index}].type`),
      contentSha256: nonEmpty(row.content_sha256, `Amara manifest.items[${index}].content_sha256`),
    };
    if (!/^[a-f0-9]{64}$/.test(normalized.contentSha256)) throw new Error(`${normalized.slug} has an invalid content_sha256`);
    if (slugs.has(normalized.slug)) throw new Error(`Amara manifest has duplicate slug ${normalized.slug}`);
    slugs.add(normalized.slug);
    return normalized;
  });
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The JSONL records are ingested one-for-one. Canonical JSON makes their manifest identity stable
 * even if a checkout's line endings differ. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

export function renderAmaraJsonRecord(raw: unknown, kind: 'email' | 'slack'): { title: string; body: string; canonicalSource: string } {
  const value = record(raw, `${kind} record`);
  const canonicalSource = canonicalJson(value);
  if (kind === 'email') {
    const subject = nonEmpty(value.subject, 'email.subject');
    const bodyText = nonEmpty(value.body_text, 'email.body_text');
    const from = value.from && typeof value.from === 'object' ? value.from as RecordValue : {};
    const to = Array.isArray(value.to) ? value.to.map((person) => {
      const row = record(person, 'email.to[]');
      return String(row.name ?? row.email ?? 'unknown');
    }).join(', ') : '';
    return { title: subject, body: `From: ${String(from.name ?? from.email ?? 'unknown')}\nTo: ${to}\nDate: ${String(value.ts ?? '')}\nSubject: ${subject}\n\n${bodyText}`, canonicalSource };
  }
  const text = nonEmpty(value.text, 'slack.text');
  const user = value.user && typeof value.user === 'object' ? value.user as RecordValue : {};
  const channel = String(value.channel ?? '');
  return { title: `${channel}: ${String(user.name ?? user.handle ?? 'unknown')}`, body: `Channel: ${channel}\nAuthor: ${String(user.name ?? user.handle ?? 'unknown')}\nDate: ${String(value.ts ?? '')}\n\n${text}`, canonicalSource };
}

/** Calendar source is split into individual VEVENT documents, preserving exact source bytes for
 * manifest hashing. Folding is intentionally not rewritten: the benchmark fixture supplies simple
 * RFC-5545 events and mutation would make provenance unverifiable. */
export function parseAmaraCalendar(ics: string): Array<{ slug: string; title: string; body: string; source: string }> {
  const normal = ics.replace(/\r\n/g, '\n');
  const events = normal.match(/BEGIN:VEVENT\n[\s\S]*?\nEND:VEVENT/g) ?? [];
  return events.map((source) => {
    const uid = /^UID:([^\n]+)/m.exec(source)?.[1]?.trim();
    if (!uid) throw new Error('calendar VEVENT missing UID');
    const slug = `cal/${uid.replace(/@.*$/, '')}`;
    const title = /^SUMMARY:([^\n]*)/m.exec(source)?.[1]?.trim() || slug;
    return { slug, title, body: source, source };
  });
}
