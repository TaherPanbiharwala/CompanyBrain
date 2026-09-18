/**
 * Typed retrieval policy. The intent table and exact-match normalization are behaviorally ported
 * from gbrain commit 8c70f6255047a7647adb30b1d6333a48068d9fa5 under MIT (see NOTICE).
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RRF_K } from './rrf.ts';
import type { QueryClassification, QueryIntent } from './query-intent.ts';
import type { EffectiveRecencyMode } from './recency-decay.ts';

export type RecencyMode = 'off' | 'auto' | 'on' | 'strong';

export interface IntentWeights {
  keywordWeight: number;
  vectorWeight: number;
  suggestedRecency: 'off' | 'on' | 'strong' | null;
  exactMatchBoost: number;
}

export interface RetrievalKnobs {
  candidatePool: {
    vectorLimit: number;
    keywordAndLimit: number;
    keywordOrLimit: number;
    titleLimit: number;
    maxPerPage: number;
    rerankOverfetch: number;
  };
  keyword: {
    minTermChars: number;
    maxTerms: number;
  };
  fusion: {
    rrfK: number;
    keywordAndWeight: number;
    keywordOrWeight: number;
    vectorWeight: number;
    titleWeight: number;
    rrfBlend: number;
    cosineBlend: number;
    autocutRatio: number;
  };
  intent: {
    enabled: boolean;
    weights: Record<QueryIntent, IntentWeights>;
  };
  recency: {
    mode: RecencyMode;
    halflifeDays: number;
    coefficient: number;
  };
}

type DeepPartial<T> = { [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P] };
export type RetrievalKnobOverrides = DeepPartial<RetrievalKnobs>;
export type DeepReadonly<T> = { readonly [P in keyof T]: T[P] extends object ? DeepReadonly<T[P]> : T[P] };

const positiveWeight = z.number().finite().positive().max(4);
const intentWeightSchema = z.object({
  keywordWeight: positiveWeight,
  vectorWeight: positiveWeight,
  suggestedRecency: z.enum(['off', 'on', 'strong']).nullable(),
  exactMatchBoost: positiveWeight,
}).strict();

const candidatePoolSchema = z.object({
    vectorLimit: z.number().int().min(0).max(100),
    keywordAndLimit: z.number().int().min(0).max(100),
    keywordOrLimit: z.number().int().min(0).max(100),
    titleLimit: z.number().int().min(0).max(100),
    maxPerPage: z.number().int().min(1).max(20),
    rerankOverfetch: z.number().int().min(1).max(10),
  }).strict();
const keywordSchema = z.object({
    minTermChars: z.number().int().min(1).max(10),
    maxTerms: z.number().int().min(1).max(64),
  }).strict();
const fusionSchema = z.object({
    rrfK: z.number().finite().min(1).max(1000),
    keywordAndWeight: positiveWeight,
    keywordOrWeight: positiveWeight,
    vectorWeight: positiveWeight,
    titleWeight: positiveWeight,
    rrfBlend: z.number().finite().min(0).max(1),
    cosineBlend: z.number().finite().min(0).max(1),
    autocutRatio: z.number().finite().min(0).lt(1),
  }).strict();
const intentSchema = z.object({
    enabled: z.boolean(),
    weights: z.object({
      entity: intentWeightSchema,
      temporal: intentWeightSchema,
      event: intentWeightSchema,
      concept: intentWeightSchema,
      general: intentWeightSchema,
    }).strict(),
  }).strict();
const recencySchema = z.object({
    mode: z.enum(['off', 'auto', 'on', 'strong']),
    halflifeDays: z.number().finite().min(0).max(3650),
    coefficient: z.number().finite().min(0).max(2),
  }).strict();

const retrievalKnobsSchema = z.object({
  candidatePool: candidatePoolSchema,
  keyword: keywordSchema,
  fusion: fusionSchema,
  intent: intentSchema,
  recency: recencySchema,
}).strict().superRefine((value, context) => {
  const pool = value.candidatePool;
  const capacity = pool.vectorLimit + pool.keywordAndLimit + pool.keywordOrLimit + pool.titleLimit;
  if (capacity === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['candidatePool'], message: 'at least one retrieval arm must be enabled' });
  }
  if (capacity > 400) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['candidatePool'], message: 'combined arm capacity must be at most 400' });
  }
  if (Math.abs(value.fusion.rrfBlend + value.fusion.cosineBlend - 1) > Number.EPSILON * 4) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['fusion'], message: 'rrfBlend and cosineBlend must sum exactly to 1' });
  }
});

const overrideSchema = z.object({
  candidatePool: candidatePoolSchema.partial().strict().optional(),
  keyword: keywordSchema.partial().strict().optional(),
  fusion: fusionSchema.partial().strict().optional(),
  intent: z.object({
    enabled: z.boolean().optional(),
    weights: z.object({
      entity: intentWeightSchema.partial().strict().optional(),
      temporal: intentWeightSchema.partial().strict().optional(),
      event: intentWeightSchema.partial().strict().optional(),
      concept: intentWeightSchema.partial().strict().optional(),
      general: intentWeightSchema.partial().strict().optional(),
    }).strict().optional(),
  }).strict().optional(),
  recency: recencySchema.partial().strict().optional(),
}).strict();

const GBRAIN_INTENT_WEIGHTS: Record<QueryIntent, IntentWeights> = {
  entity: { keywordWeight: 1.15, vectorWeight: 1, suggestedRecency: null, exactMatchBoost: 1.25 },
  temporal: { keywordWeight: 1, vectorWeight: 1, suggestedRecency: 'on', exactMatchBoost: 1 },
  event: { keywordWeight: 1.2, vectorWeight: 0.95, suggestedRecency: 'on', exactMatchBoost: 1.1 },
  concept: { keywordWeight: 0.9, vectorWeight: 1.2, suggestedRecency: null, exactMatchBoost: 1 },
  general: { keywordWeight: 1, vectorWeight: 1, suggestedRecency: null, exactMatchBoost: 1 },
};

const BASE_PROFILE: RetrievalKnobs = {
  candidatePool: {
    vectorLimit: 20,
    keywordAndLimit: 20,
    keywordOrLimit: 10,
    titleLimit: 10,
    maxPerPage: 2,
    rerankOverfetch: 4,
  },
  keyword: { minTermChars: 3, maxTerms: 32 },
  fusion: {
    rrfK: RRF_K,
    keywordAndWeight: 1,
    keywordOrWeight: 0.4,
    vectorWeight: 1,
    titleWeight: 0.5,
    rrfBlend: 0.7,
    cosineBlend: 0.3,
    autocutRatio: 0,
  },
  intent: { enabled: false, weights: GBRAIN_INTENT_WEIGHTS },
  recency: { mode: 'off', halflifeDays: 90, coefficient: 0.3 },
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export const BASELINE_RETRIEVAL_KNOBS: DeepReadonly<RetrievalKnobs> = deepFreeze(clone(BASE_PROFILE));
export const GBRAIN_RETRIEVAL_KNOBS: DeepReadonly<RetrievalKnobs> = deepFreeze({
  ...clone(BASE_PROFILE),
  intent: { enabled: true, weights: clone(GBRAIN_INTENT_WEIGHTS) },
});

/** Remains baseline until the registered held-out and NovaByte gates justify promotion. */
export const DEFAULT_RETRIEVAL_KNOBS: DeepReadonly<RetrievalKnobs> = BASELINE_RETRIEVAL_KNOBS;

function mergeKnobs(base: RetrievalKnobs, override: RetrievalKnobOverrides): RetrievalKnobs {
  return {
    candidatePool: { ...base.candidatePool, ...override.candidatePool },
    keyword: { ...base.keyword, ...override.keyword },
    fusion: { ...base.fusion, ...override.fusion },
    intent: {
      ...base.intent,
      ...override.intent,
      weights: {
        entity: { ...base.intent.weights.entity, ...override.intent?.weights?.entity },
        temporal: { ...base.intent.weights.temporal, ...override.intent?.weights?.temporal },
        event: { ...base.intent.weights.event, ...override.intent?.weights?.event },
        concept: { ...base.intent.weights.concept, ...override.intent?.weights?.concept },
        general: { ...base.intent.weights.general, ...override.intent?.weights?.general },
      },
    },
    recency: { ...base.recency, ...override.recency },
  };
}

function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => {
    const path = issue.path.join('.') || 'root';
    if (issue.code === z.ZodIssueCode.unrecognized_keys) {
      return issue.keys.map((key) => `${path === 'root' ? '' : `${path}.`}${key}: unknown field`).join('; ');
    }
    return `${path}: ${issue.message}`;
  }).join('; ');
}

export function validateRetrievalKnobs(value: unknown): RetrievalKnobs {
  const result = retrievalKnobsSchema.safeParse(value);
  if (!result.success) throw new Error(`Invalid retrieval knobs: ${describeIssues(result.error)}`);
  return result.data;
}

export function parseRetrievalKnobOverrides(raw: string | undefined): RetrievalKnobOverrides {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid CB_RETRIEVAL_KNOBS_JSON: malformed JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const result = overrideSchema.safeParse(parsed);
  if (!result.success) throw new Error(`Invalid CB_RETRIEVAL_KNOBS_JSON: ${describeIssues(result.error)}`);
  return result.data;
}

export function resolveRetrievalKnobs(options: {
  defaults?: DeepReadonly<RetrievalKnobs>;
  reserved?: RetrievalKnobOverrides;
  environment?: RetrievalKnobOverrides;
  caller?: RetrievalKnobOverrides;
} = {}): RetrievalKnobs {
  let resolved = clone(options.defaults ?? DEFAULT_RETRIEVAL_KNOBS) as RetrievalKnobs;
  for (const candidate of [options.reserved, options.environment, options.caller]) {
    if (!candidate) continue;
    const checked = overrideSchema.safeParse(candidate);
    if (!checked.success) throw new Error(`Invalid retrieval knob override: ${describeIssues(checked.error)}`);
    resolved = mergeKnobs(resolved, checked.data);
  }
  return deepFreeze(validateRetrievalKnobs(resolved));
}

/** Canonical server-wide override parsed once by config.ts at process startup. */
export function resolveEnvironmentRetrievalKnobs(raw: string | undefined): RetrievalKnobs {
  return resolveRetrievalKnobs({ environment: parseRetrievalKnobOverrides(raw) });
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

export function retrievalKnobHash(knobs: DeepReadonly<RetrievalKnobs>): string {
  const validated = validateRetrievalKnobs(knobs);
  return createHash('sha256').update(JSON.stringify(canonicalize(validated))).digest('hex');
}

export function effectiveIntentWeights(knobs: DeepReadonly<RetrievalKnobs>, intent: QueryIntent): DeepReadonly<IntentWeights> {
  return knobs.intent.enabled
    ? knobs.intent.weights[intent]
    : { keywordWeight: 1, vectorWeight: 1, suggestedRecency: null, exactMatchBoost: 1 };
}

export function effectiveRecencyMode(
  knobs: DeepReadonly<RetrievalKnobs>,
  classification: QueryClassification,
): EffectiveRecencyMode {
  if (knobs.recency.mode !== 'auto') return knobs.recency.mode;
  if (classification.recencySuppressed) return 'off';
  if (classification.suggestedRecency !== 'off') return classification.suggestedRecency;
  // Auto-recency is independently ablatable from intent fusion/exact matching. The intent table is
  // therefore still the fallback when intent.enabled=false (the `recency-auto-only` sweep profile).
  return knobs.intent.weights[classification.intent].suggestedRecency ?? 'off';
}

export function normalizeExactQuery(query: string): { normalized: string; kebab: string } {
  const normalized = query.toLowerCase().trim();
  return { normalized, kebab: normalized.replace(/\s+/g, '-') };
}

export function isExactMatch(query: string, slug: string | null | undefined, title: string | null | undefined): boolean {
  const { normalized, kebab } = normalizeExactQuery(query);
  if (!normalized) return false;
  const normalizedSlug = (slug ?? '').toLowerCase();
  const normalizedTitle = (title ?? '').toLowerCase().trim();
  return normalizedSlug === normalized || normalizedSlug === kebab || normalizedSlug.endsWith(`/${kebab}`) || normalizedTitle === normalized;
}
