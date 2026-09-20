// Pure fact-extraction prompt + response parsing (M10 wave 1). No DB, no I/O — deliberately, so it
// is unit-testable directly and reusable if a second call site (e.g. a future synchronous hook) ever
// needs it. Mirrors links/extract.ts's separation of pure algorithm from its DB-touching phase file,
// and answer.ts's parseAnswerJson discipline: strip a ```json fence, JSON.parse defensively, validate
// with zod, never throw — a malformed response degrades to fewer facts, never a phase failure.
import { z } from 'zod';
import type { ChatMessage } from '../../ai/router.ts';

/** One LLM call reads at most this many characters of a page's body — gbrain's own precedent for a
 *  single-call, per-page extraction prompt. Truncated, not chunked: a fact worth extracting is
 *  usually stated early, and chunk-level extraction would multiply the LLM call count by page length
 *  for a milestone whose own sizing note calls it "the largest LLM spend of any milestone here". */
export const FACT_EXTRACTION_MAX_CHARS = 8000;

/** Matches the JSON schema's own cap below — a hard ceiling in the prompt text is advisory only. */
export const MAX_FACTS_PER_CALL = 10;

export type FactKind = 'event' | 'preference' | 'commitment' | 'belief' | 'fact';
export type Notability = 'high' | 'medium' | 'low';

const FACT_KINDS: readonly FactKind[] = ['event', 'preference', 'commitment', 'belief', 'fact'];
const NOTABILITIES: readonly Notability[] = ['high', 'medium', 'low'];

export interface ExtractedFact {
  /** Slugified from the model's free-text entity field. null when no single clear subject, or when
   *  the free text normalized to nothing (pure punctuation/whitespace). No FK to pages.slug —
   *  an entity is not always a page (gbrain precedent). */
  entitySlug: string | null;
  kind: FactKind;
  notability: Notability;
  confidence: number;
  claimText: string;
  sourceExcerpt: string;
  claimMetric: string | null;
  claimValue: number | null;
  claimUnit: string | null;
  claimPeriod: string | null;
  eventType: string | null;
}

const FACT_EXTRACTION_SYSTEM = `You extract discrete, verifiable factual claims from a single document.

Reply with STRICT single-line JSON and nothing else — no prose, no markdown fence:
{"facts":[{"entity":"...","kind":"fact","notability":"medium","confidence":0.9,"claim_text":"...","source_excerpt":"...","claim_metric":null,"claim_value":null,"claim_unit":null,"claim_period":null,"event_type":null}]}

Field rules:
- entity: the primary subject of the claim — a short name for a person, company, product, or project. null if there is no single clear subject.
- kind: one of event, preference, commitment, belief, fact.
- notability: one of high, medium, low — how important this claim is to remember later.
- confidence: a number from 0 to 1, how certain the document makes this claim.
- claim_text: one self-contained sentence stating the claim, in your own words.
- source_excerpt: a short verbatim quote (under 240 characters) from the document that grounds the claim.
- claim_metric/claim_value/claim_unit/claim_period: only for a claim that states a specific metric at a point in time (e.g. "MRR was $40k in 2026-Q3" -> metric "MRR", value 40000, unit "USD", period "2026-Q3"). null otherwise.
- event_type: only when kind is "event" — a short category such as "meeting", "launch", "hire". null otherwise.

Extract at most ${MAX_FACTS_PER_CALL} facts. Only extract what the document actually states — never infer, speculate, or use outside knowledge. If the document states nothing worth remembering, reply {"facts":[]}.`;

export interface FactExtractionPage {
  title: string | null;
  slug: string;
  kind: string;
  tags: readonly string[];
}

export function buildFactExtractionMessages(page: FactExtractionPage, text: string): ChatMessage[] {
  const truncated = text.length > FACT_EXTRACTION_MAX_CHARS;
  const body = text.slice(0, FACT_EXTRACTION_MAX_CHARS);
  const header =
    `Title: ${page.title ?? page.slug}\n` +
    `Kind: ${page.kind}\n` +
    (page.tags.length > 0 ? `Tags: ${page.tags.join(', ')}\n` : '') +
    `\n---\n\n`;
  return [
    { role: 'system', content: FACT_EXTRACTION_SYSTEM },
    { role: 'user', content: header + body + (truncated ? '\n\n[document truncated]' : '') },
  ];
}

const rawFactSchema = z.object({
  entity: z.string().trim().min(1).max(200).nullish(),
  kind: z.string().nullish(),
  notability: z.string().nullish(),
  confidence: z.number().nullish(),
  claim_text: z.string().trim().min(1).max(500),
  source_excerpt: z.string().trim().max(500).nullish(),
  claim_metric: z.string().trim().max(200).nullish(),
  claim_value: z.number().nullish(),
  claim_unit: z.string().trim().max(50).nullish(),
  claim_period: z.string().trim().max(50).nullish(),
  event_type: z.string().trim().max(100).nullish(),
});

const rawResponseSchema = z.object({
  facts: z.array(z.unknown()).max(50), // 50, not MAX_FACTS_PER_CALL: cap array SIZE generously here,
  // enforce the real per-call cap by slicing below — a model that ignores the prompt's advisory limit
  // should degrade to "extra facts dropped", not "whole response rejected".
});

/** Local, minimal slugify — deliberately not src/eval/slug.ts's `slugify`, which exists to turn a
 *  dataset document id into a globally-unique page slug (hash-suffixed collision resistance) and
 *  lives in an eval-only leaf module core code should not depend on. Entity-slug normalization wants
 *  the opposite property: two spellings of the same name ("Acme Corp", "ACME CORP.") SHOULD collapse
 *  to the same slug, since that collapsing is what makes entity-scoped grouping/dedup work at all. */
function slugifyEntity(entity: string): string | null {
  const normalized = entity
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
  return normalized.length > 0 ? normalized : null;
}

function normalizeFact(candidate: unknown): ExtractedFact | null {
  const parsed = rawFactSchema.safeParse(candidate);
  if (!parsed.success) return null;
  const raw = parsed.data;

  const kind = FACT_KINDS.includes(raw.kind as FactKind) ? (raw.kind as FactKind) : 'fact';
  const notability = NOTABILITIES.includes(raw.notability as Notability) ? (raw.notability as Notability) : 'medium';
  const confidence =
    typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
      ? Math.min(1, Math.max(0, raw.confidence))
      : 1.0;

  return {
    entitySlug: raw.entity ? slugifyEntity(raw.entity) : null,
    kind,
    notability,
    confidence,
    claimText: raw.claim_text,
    sourceExcerpt: raw.source_excerpt ?? '',
    claimMetric: raw.claim_metric ?? null,
    claimValue: typeof raw.claim_value === 'number' && Number.isFinite(raw.claim_value) ? raw.claim_value : null,
    claimUnit: raw.claim_unit ?? null,
    claimPeriod: raw.claim_period ?? null,
    eventType: kind === 'event' ? (raw.event_type ?? null) : null,
  };
}

export interface ParsedFactExtraction {
  facts: ExtractedFact[];
  /** True when the top-level response could not be read as {facts:[...]} at all — every fact in this
   *  call is lost, not just malformed individual entries. Surfaced so the caller can log/record it,
   *  matching answer.ts's parseDegraded convention. */
  parseFailed: boolean;
}

/** Never throws. A response that fails to parse as JSON, or whose top-level shape is not
 *  {facts:[...]}, degrades to zero facts with parseFailed:true. An individual malformed fact entry
 *  inside an otherwise-valid array is dropped on its own — the model getting one field wrong should
 *  not cost every other fact it correctly extracted on the same page. */
export function parseFactExtractionResponse(raw: string): ParsedFactExtraction {
  const unfenced = raw.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```$/, '');

  for (const candidate of raw === unfenced ? [raw] : [raw, unfenced]) {
    try {
      const obj: unknown = JSON.parse(candidate);
      const top = rawResponseSchema.safeParse(obj);
      if (top.success) {
        const facts = top.data.facts
          .slice(0, MAX_FACTS_PER_CALL)
          .map(normalizeFact)
          .filter((f): f is ExtractedFact => f !== null);
        return { facts, parseFailed: false };
      }
    } catch {
      // try the next candidate, then fall through to the failure below
    }
  }
  return { facts: [], parseFailed: true };
}
