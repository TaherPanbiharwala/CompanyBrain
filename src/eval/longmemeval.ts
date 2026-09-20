// Pure LongMemEval-S normalisation and scoring. The runner owns filesystem, Postgres and provider
// work; this module deliberately cannot make a model call, so malformed input is rejected before
// the first billable operation.
import { createHash } from 'node:crypto';

export const LONGMEMEVAL_S_CASE_COUNT = 500;
export const LONGMEMEVAL_TOP_K = 5;

export interface LongMemEvalTurn {
  role: string;
  content: string;
}

export interface LongMemEvalCase {
  questionId: string;
  type: string;
  question: string;
  answer: string;
  sessionIds: string[];
  sessions: LongMemEvalTurn[][];
  goldSessionIds: string[];
}

export interface LongMemEvalScore {
  questionId: string;
  type: string;
  recallAllAt5: number;
  anySessionRecallAt5: number;
  evidenceRecallAt5: number;
  latencyMs: number;
  degraded: boolean;
  error?: string;
  rankedSessionIds: string[];
}

export interface LongMemEvalSummary {
  denominator: number;
  recall_all_at_5: number;
  any_session_recall_at_5: number;
  evidence_recall_at_5: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  degraded_retrievals: number;
  failures: number;
  per_type: Record<string, Pick<LongMemEvalSummary, 'denominator' | 'recall_all_at_5' | 'any_session_recall_at_5' | 'evidence_recall_at_5'>>;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as UnknownRecord;
}

function stringField(row: UnknownRecord, field: string, label: string): string {
  const value = row[field];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label}.${field} must be a non-empty string`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.trim() === '')) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return [...value] as string[];
}

/** Validate all structural and gold/session relationships. `expectedCount` is optional only for
 * fixtures; the command always supplies the public split's required 500. */
export function normalizeLongMemEval(raw: unknown, expectedCount?: number): LongMemEvalCase[] {
  if (!Array.isArray(raw)) throw new Error('LongMemEval file must contain a JSON array');
  if (expectedCount !== undefined && raw.length !== expectedCount) {
    throw new Error(`LongMemEval split has ${raw.length} cases; expected exactly ${expectedCount}`);
  }
  const ids = new Set<string>();
  return raw.map((value, index) => {
    const label = `case[${index}]`;
    const row = asRecord(value, label);
    const questionId = stringField(row, 'question_id', label);
    if (ids.has(questionId)) throw new Error(`${label}.question_id duplicates ${questionId}`);
    ids.add(questionId);
    const sessionIds = stringArray(row.haystack_session_ids, `${label}.haystack_session_ids`);
    const goldSessionIds = stringArray(row.answer_session_ids, `${label}.answer_session_ids`);
    if (new Set(sessionIds).size !== sessionIds.length) throw new Error(`${label} has duplicate haystack session ids`);
    if (new Set(goldSessionIds).size !== goldSessionIds.length) throw new Error(`${label} has duplicate answer session ids`);
    const sessionsRaw = row.haystack_sessions;
    if (!Array.isArray(sessionsRaw) || sessionsRaw.length !== sessionIds.length) {
      throw new Error(`${label} has ${Array.isArray(sessionsRaw) ? sessionsRaw.length : 'non-array'} sessions for ${sessionIds.length} ids`);
    }
    const sessions = sessionsRaw.map((session, sessionIndex) => {
      if (!Array.isArray(session) || session.length === 0) throw new Error(`${label}.haystack_sessions[${sessionIndex}] must be a non-empty turn array`);
      return session.map((turn, turnIndex) => {
        const turnRow = asRecord(turn, `${label}.haystack_sessions[${sessionIndex}][${turnIndex}]`);
        return {
          role: stringField(turnRow, 'role', `${label}.haystack_sessions[${sessionIndex}][${turnIndex}]`),
          content: stringField(turnRow, 'content', `${label}.haystack_sessions[${sessionIndex}][${turnIndex}]`),
        };
      });
    });
    const sessionIdSet = new Set(sessionIds);
    for (const gold of goldSessionIds) {
      if (!sessionIdSet.has(gold)) throw new Error(`${label} gold session ${gold} is not in haystack_session_ids`);
    }
    return {
      questionId,
      type: stringField(row, 'question_type', label),
      question: stringField(row, 'question', label),
      answer: stringField(row, 'answer', label),
      sessionIds,
      sessions,
      goldSessionIds,
    };
  });
}

export function renderLongMemEvalSession(turns: readonly LongMemEvalTurn[]): string {
  return turns.map((turn) => `${turn.role}: ${turn.content}`).join('\n\n');
}

/** A case namespace plus an immutable hash means the same source session may safely occur in many
 * isolated cases, while no normalisation collision can overwrite a page. */
export function longMemEvalSessionSlug(questionId: string, sessionId: string): string {
  const digest = createHash('sha256').update(`${questionId}\u0000${sessionId}`).digest('hex').slice(0, 20);
  return `lme-${digest}`;
}

/** Stable, seedable stratification. Quotients preserve the source type distribution; the remaining
 * slots go to the largest fractional quota, with seed-hash tie breaks. */
export function sampleLongMemEval(
  cases: readonly LongMemEvalCase[],
  count: number,
  seed: number,
): LongMemEvalCase[] {
  if (!Number.isInteger(count) || count < 1 || count > cases.length) throw new Error(`--sample must be 1..${cases.length}`);
  if (!Number.isInteger(seed)) throw new Error('--sample-seed must be an integer');
  const groups = new Map<string, LongMemEvalCase[]>();
  for (const item of cases) groups.set(item.type, [...(groups.get(item.type) ?? []), item]);
  const quotas = [...groups.entries()].map(([type, items]) => ({ type, items, quota: (items.length * count) / cases.length }));
  let assigned = 0;
  const take = new Map<string, number>();
  for (const group of quotas) {
    const n = Math.floor(group.quota);
    take.set(group.type, n);
    assigned += n;
  }
  quotas.sort((a, b) => {
    const delta = (b.quota % 1) - (a.quota % 1);
    if (delta !== 0) return delta;
    return seededNumber(`${seed}:${a.type}`) - seededNumber(`${seed}:${b.type}`);
  });
  for (let i = 0; assigned < count; i++, assigned++) take.set(quotas[i % quotas.length]!.type, (take.get(quotas[i % quotas.length]!.type) ?? 0) + 1);
  const chosen: LongMemEvalCase[] = [];
  for (const [type, items] of groups) {
    const ordered = [...items].sort((a, b) => seededNumber(`${seed}:${a.questionId}`) - seededNumber(`${seed}:${b.questionId}`) || a.questionId.localeCompare(b.questionId));
    chosen.push(...ordered.slice(0, take.get(type) ?? 0));
  }
  return chosen.sort((a, b) => a.questionId.localeCompare(b.questionId));
}

/** Called by the runner before it creates a workspace or enters router scope. Keeping this tiny
 * guard pure makes the "deny before provider call" property directly testable. */
export function assertLongMemEvalBudget(estimatedUsd: number, maxUsd: number): void {
  if (!Number.isFinite(estimatedUsd) || !Number.isFinite(maxUsd) || estimatedUsd < 0 || maxUsd <= 0) {
    throw new Error('LongMemEval budget values must be finite and non-negative/positive');
  }
  if (estimatedUsd > maxUsd) throw new Error(`preflight refuses this campaign: estimated embedding cost $${estimatedUsd.toFixed(4)} exceeds cap $${maxUsd.toFixed(4)}`);
}

/** Resume never has a best-effort mode: a different data/config identity creates a new campaign
 * rather than mixing incomparable rows under one report. */
export function assertLongMemEvalResumeIdentity(
  saved: { sourceSha256: string; configurationHash: string; selectedQuestionIds: readonly string[] },
  expected: { sourceSha256: string; configurationHash: string; selectedQuestionIds: readonly string[] },
): void {
  if (
    saved.sourceSha256 !== expected.sourceSha256 ||
    saved.configurationHash !== expected.configurationHash ||
    JSON.stringify(saved.selectedQuestionIds) !== JSON.stringify(expected.selectedQuestionIds)
  ) {
    throw new Error('resume refused: dataset, selected sample, model, or retrieval configuration does not match the immutable campaign state');
  }
}

function seededNumber(value: string): number {
  return Number.parseInt(createHash('sha256').update(value).digest('hex').slice(0, 12), 16);
}

export function scoreLongMemEvalCase(
  item: LongMemEvalCase,
  rankedSessionIds: readonly string[],
  opts: { latencyMs: number; degraded?: boolean; error?: string },
): LongMemEvalScore {
  // Rank is by CHUNK. A repeat chunk cannot earn another gold hit, but it still consumes one of five
  // positions before the unique session ids are formed.
  const top = rankedSessionIds.slice(0, LONGMEMEVAL_TOP_K);
  const found = new Set(top);
  const gold = new Set(item.goldSessionIds);
  const hitCount = [...gold].filter((id) => found.has(id)).length;
  return {
    questionId: item.questionId,
    type: item.type,
    recallAllAt5: hitCount === gold.size ? 1 : 0,
    anySessionRecallAt5: hitCount > 0 ? 1 : 0,
    evidenceRecallAt5: hitCount / gold.size,
    latencyMs: opts.latencyMs,
    degraded: opts.degraded ?? false,
    error: opts.error,
    rankedSessionIds: top,
  };
}

/** Build a campaign scorecard from checkpointed state in the immutable dataset order. The current
 * command slice is deliberately absent from this API: a resume must not hide earlier scores. */
export function completedLongMemEvalScores(
  cases: readonly LongMemEvalCase[],
  scoresByQuestionId: Readonly<Record<string, LongMemEvalScore | undefined>>,
): LongMemEvalScore[] {
  return cases.flatMap((item) => {
    const score = scoresByQuestionId[item.questionId];
    return score ? [score] : [];
  });
}

function quantile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(p * ordered.length) - 1)]!;
}

function aggregate(scores: readonly LongMemEvalScore[]): Omit<LongMemEvalSummary, 'per_type'> {
  const n = scores.length || 1;
  return {
    denominator: scores.length,
    recall_all_at_5: scores.reduce((sum, score) => sum + score.recallAllAt5, 0) / n,
    any_session_recall_at_5: scores.reduce((sum, score) => sum + score.anySessionRecallAt5, 0) / n,
    evidence_recall_at_5: scores.reduce((sum, score) => sum + score.evidenceRecallAt5, 0) / n,
    p50_latency_ms: quantile(scores.map((score) => score.latencyMs), 0.5),
    p95_latency_ms: quantile(scores.map((score) => score.latencyMs), 0.95),
    degraded_retrievals: scores.filter((score) => score.degraded).length,
    failures: scores.filter((score) => score.error !== undefined).length,
  };
}

export function summarizeLongMemEval(scores: readonly LongMemEvalScore[]): LongMemEvalSummary {
  const perType: LongMemEvalSummary['per_type'] = {};
  for (const type of [...new Set(scores.map((score) => score.type))].sort()) {
    const { p50_latency_ms: _p50, p95_latency_ms: _p95, degraded_retrievals: _degraded, failures: _failures, ...summary } = aggregate(scores.filter((score) => score.type === type));
    perType[type] = summary;
  }
  return { ...aggregate(scores), per_type: perType };
}
