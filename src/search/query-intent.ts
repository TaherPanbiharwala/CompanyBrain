/**
 * Zero-LLM query classification, behaviorally ported from gbrain at
 * 8c70f6255047a7647adb30b1d6333a48068d9fa5 under MIT (see NOTICE).
 *
 * Deliberately omitted: detail, salience, modality, runtime pattern extensions, and per-brain
 * configuration. This module is pure and its priority is part of the retrieval-policy contract.
 */

export type QueryIntent = 'entity' | 'temporal' | 'event' | 'concept' | 'general';
export type SuggestedRecency = 'off' | 'on' | 'strong';

export interface QueryClassification {
  intent: QueryIntent;
  suggestedRecency: SuggestedRecency;
  /** Canonical lookup without an explicit time bound: blocks the intent-table fallback in auto. */
  recencySuppressed?: boolean;
}

const TEMPORAL_PATTERNS = [
  /\bwhen\b/i,
  /\blast\s+(met|meeting|call|conversation|chat|talked|spoke|seen|heard|time)\b/i,
  /\brecent(ly)?\b/i,
  /\bhistory\b/i,
  /\btimeline\b/i,
  /\bmeeting\s+notes?\b/i,
  /\bwhat('s| is| was)\s+new\b/i,
  /\blatest\b/i,
  /\bupdate(s)?\s+(on|from|about)\b/i,
  /\bhow\s+long\s+(ago|since)\b/i,
  /\b\d{4}[-/]\d{2}\b/i,
  /\blast\s+(week|month|quarter|year)\b/i,
];

const EVENT_PATTERNS = [
  /\bannounce[ds]?(ment)?\b/i,
  /\blaunch(ed|es|ing)?\b/i,
  /\braised?\s+\$?\d/i,
  /\bfund(ing|raise)\b/i,
  /\bIPO\b/i,
  /\bacquisition\b/i,
  /\bmerge[drs]?\b/i,
  /\bnews\b/i,
  /\bhappened?\b/i,
];

const ENTITY_PATTERNS = [
  /\bwho\s+is\b/i,
  /\bwhat\s+(is|does|are)\b/i,
  /\btell\s+me\s+about\b/i,
  /\bdescribe\b/i,
  /\bsummar(y|ize)\b/i,
  /\boverview\b/i,
  /\bbackground\b/i,
  /\bprofile\b/i,
  /\bwhat\s+do\s+(i|you|we)\s+know\b/i,
];

const FULL_CONTEXT_PATTERNS = [
  /\beverything\b/i,
  /\ball\s+(about|info|information|details)\b/i,
  /\bfull\s+(history|context|picture|story|details)\b/i,
  /\bcomprehensive\b/i,
  /\bdeep\s+dive\b/i,
  /\bgive\s+me\s+everything\b/i,
];

const CANONICAL_PATTERNS = [
  /\bwho\s+is\b/i,
  /\bwhat\s+(is|are|does|means?)\b/i,
  /\bdefin(e|ition|ing)\b/i,
  /\bexplain\s+(what|how|why)\b/i,
  /\b(history|origin|background)\s+of\b/i,
  /\bconcept\s+of\b/i,
  /\boverview\s+of\b/i,
  /\btell\s+me\s+about\b/i,
  /\bcompiled\s+truth\b/i,
  /::|->|\.\w+\(/,
  /\b(function|class|method|module)\s+\w+/i,
  /\b(graph|traversal|backlinks?|inbound|outbound)\b/i,
];

const STRONG_RECENCY_PATTERNS = [
  /\btoday\b/i,
  /\bright\s+now\b/i,
  /\bthis\s+morning\b/i,
  /\bjust\s+now\b/i,
];

const RECENCY_ON_PATTERNS = [
  /\bwhat'?s\s+(going\s+on|happening|new|latest|up)\b/i,
  /\b(latest|recent(ly)?|currently)\b/i,
  /\b(this|last|past)\s+(week|month|few\s+days|couple\s+days)\b/i,
  /\bmeeting\s+(prep|with|for|notes?|brief)\b/i,
  /\bbefore\s+(my|the|our)\s+(meeting|call|sync|chat)\b/i,
  /\bprep(are)?\s+(for|me)\b/i,
  /\bcatch(es|ing)?\b[\s\w]{0,15}\bup\b/i,
  /\bremind\s+me\s+(what|about|of)\b/i,
  /\b(update|status|progress)\s+(on|with|from)\b/i,
];

const EXPLICIT_TEMPORAL_BOUND_PATTERNS = [
  /\btoday\b/i,
  /\bright\s+now\b/i,
  /\bthis\s+morning\b/i,
  /\bthis\s+week\b/i,
  /\bsince\s+(launch|last|the|\d)/i,
  /\blast\s+\d+\s+(day|days|week|weeks|month|months)\b/i,
];

export const CONCEPT_CUE_PATTERNS: readonly RegExp[] = [
  /\b(all|every)\b.+\b(that|who|which|doing|with|about|related to)\b/i,
  /\b(find|list|show)\s+(all|every|everything)\b/i,
  /\beverything\s+(about|on|matching|related)\b/i,
  /\bthe\s+(landscape|ecosystem|space|universe)\s+of\b/i,
  /\b(landscape|ecosystem)\s+(of|around)\b/i,
  /\bwhich\s+\w+[\w\s]*\b(do|does|are|have|use|work)\b/i,
];

export const CONCEPT_DEFINITIONAL_PATTERNS: readonly RegExp[] = [
  /\b[Ww]hat\s+(is|are)\s+(the\s+)?[a-z][\w'’-]*\s+[a-z]/,
  /\b[Ww]hat\s+do\s+(i|you|we)\s+know\s+about\s+[a-z][\w'’-]*\s+[a-z]/,
  /\b(notes|ideas|thinking|thoughts|writing)\s+(on|about)\b/i,
  /\bways\s+to\b/i,
  /\bhow\s+to\s+think\s+about\b/i,
  /\bconcept\s+of\b/i,
];

const CONCEPT_STATUS_ANTI_RE = /\b(working on|up to|doing|saying|talking about|focused on|meeting with)\b/i;
const CONCEPT_ANTI_PATTERNS = [
  /["'“”][^"'“”]+["'“”]/,
  /\b[a-z0-9]+(?:-[a-z0-9]+){1,}\b/,
];

function matches(patterns: readonly RegExp[], query: string): boolean {
  return patterns.some((pattern) => pattern.test(query));
}

function hasMidSentenceCapital(query: string): boolean {
  for (const match of query.matchAll(/\s(\p{Lu})/gu)) {
    let i = match.index ?? 0;
    while (i >= 0 && /\s/.test(query[i] ?? '')) i--;
    if (i >= 0 && !/[.!?:;\n\r•\-(["“]/.test(query[i] ?? '')) return true;
  }
  return false;
}

export function isConceptShapedQuery(query: string): boolean {
  const q = query.trim();
  if (q.split(/\s+/).length < 3) return false;
  const definitional = matches(CONCEPT_DEFINITIONAL_PATTERNS, q);
  if (!matches(CONCEPT_CUE_PATTERNS, q) && !definitional) return false;
  if (matches(CONCEPT_ANTI_PATTERNS, q) || hasMidSentenceCapital(q)) return false;
  if (definitional && !matches(CONCEPT_CUE_PATTERNS, q) && CONCEPT_STATUS_ANTI_RE.test(q)) return false;
  return true;
}

/** Priority is full-context → temporal → event → concept → entity → general. */
export function classifyQueryIntent(query: string): QueryIntent {
  if (matches(FULL_CONTEXT_PATTERNS, query)) return 'temporal';
  if (matches(TEMPORAL_PATTERNS, query)) return 'temporal';
  if (matches(EVENT_PATTERNS, query)) return 'event';
  if (isConceptShapedQuery(query)) return 'concept';
  if (matches(ENTITY_PATTERNS, query)) return 'entity';
  return 'general';
}

/** Canonical queries suppress recency unless the query also names an explicit time bound. */
export function classifyQuery(query: string): QueryClassification {
  const intent = classifyQueryIntent(query);
  const canonical = matches(CANONICAL_PATTERNS, query);
  const explicitTime = matches(EXPLICIT_TEMPORAL_BOUND_PATTERNS, query);
  const recencySuppressed = canonical && !explicitTime;
  let suggestedRecency: SuggestedRecency = 'off';
  if (!recencySuppressed) {
    if (matches(STRONG_RECENCY_PATTERNS, query)) suggestedRecency = 'strong';
    else if (matches(RECENCY_ON_PATTERNS, query)) suggestedRecency = 'on';
  }
  return { intent, suggestedRecency, recencySuppressed };
}
