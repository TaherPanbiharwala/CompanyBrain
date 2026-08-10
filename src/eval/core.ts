// Pure scoring primitives shared by every dataset. No DB, no network, no clock, no filesystem —
// which is what lets test/eval-harness.test.ts exercise the whole grading surface in milliseconds
// with no Postgres and no API keys. src/search/eval-score.ts keeps the same discipline for the same
// reason.
import { slugify } from './slug.ts';
import type { EvalQuestion } from './types.ts';

/** The documents a question requires, as slugs — the form retrieval results carry. */
export function goldSlugs(q: EvalQuestion): Set<string> {
  return new Set(q.goldDocIds.map(slugify));
}

// ── Answer shape ────────────────────────────────────────────────────────────

export type AnswerClass = 'boolean' | 'entity' | 'null';

/** Measured over MultiHop-RAG's 2,556 gold answers: `Yes` 782, `no` 536, `No` 25, `Consistent` 32,
 *  `True` 10, `Agree` 9. The negative and "inconsistent/disagree" forms do not appear in this corpus
 *  but are included because their positives do, and a class that recognizes only one polarity would
 *  silently reclassify the other as an entity. */
const BOOLEAN_ANSWERS = new Set([
  'yes', 'no', 'true', 'false', 'consistent', 'inconsistent', 'agree', 'disagree',
]);

/** Normalize for comparison: case-fold, collapse whitespace, drop surrounding punctuation. Kept
 *  deliberately narrow — it must not strip internal punctuation, or `Sam Bankman-Fried` and
 *  `Sam Bankman Fried` stop being distinguishable from each other in ways a caller may care about. */
export function normalizeAnswer(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ').replace(/^[.,;:!?"'()\s]+|[.,;:!?"'()\s]+$/g, '');
}

export function classifyAnswer(gold: string): AnswerClass {
  const n = normalizeAnswer(gold);
  if (n === 'insufficient information' || n === 'insufficient info') return 'null';
  if (BOOLEAN_ANSWERS.has(n)) return 'boolean';
  return 'entity';
}

// ── Abstention ──────────────────────────────────────────────────────────────

/**
 * `partial` is the category that exists because the naive check gets it wrong.
 *
 * "The evidence doesn't state X, but based on [2] it may be Y" contains an abstention phrase and
 * would pass any keyword matcher — while having hedged and then answered anyway. On private
 * documents that is the shape that actually bites, so it is reported separately rather than folded
 * into either neighbour.
 */
export type AbstentionVerdict = 'abstained' | 'partial' | 'answered';

/** Phrasings the system prompt's "say so plainly" instruction actually produces. It mandates no
 *  fixed wording (src/answer/prompt.ts:27), so this is a recall-oriented list: a missed phrase
 *  scores a genuine abstention as `answered`, which understates the model rather than flattering it.
 *  That is the safe direction for a hallucination metric. */
const ABSTENTION_PATTERNS: RegExp[] = [
  /\b(does|do|did)\s+not\s+contain\b/i,
  /\b(doesn't|don't|didn't)\s+contain\b/i,
  /\bnot\s+enough\s+information\b/i,
  /\binsufficient\s+(information|evidence|context)\b/i,
  /\bno\s+(information|evidence|mention|reference)\b/i,
  /\b(cannot|can't|could not|couldn't|unable to)\s+(answer|determine|find|be\s+determined)\b/i,
  /\bnot\s+(stated|specified|mentioned|provided|available|present)\b/i,
  /\bevidence\s+(provided\s+)?does\s+not\b/i,
  /\bis\s+not\s+in\s+the\s+(evidence|documents?|provided)\b/i,
];

/** Contrastive continuations that turn an abstention into an assertion. Deliberately narrow: these
 *  are hedge-then-answer connectives, not ordinary prose, so a plain abstention will not trip them. */
const ASSERTION_PATTERNS: RegExp[] = [
  /\b(but|however|although|though)\b/i,
  /\bbased\s+on\b/i,
  /\bit\s+(may|might|could|would)\s+be\b/i,
  /\b(suggests?|implies|indicates?|appears?\s+to\s+be)\b/i,
  /\bthe\s+(closest|best|most\s+likely)\b/i,
];

export function hasAbstentionPhrase(answer: string): boolean {
  return ABSTENTION_PATTERNS.some((re) => re.test(answer));
}

/**
 * The three-part conjunction: an abstention phrase AND no citations AND no declarative claim.
 *
 * Each condition alone gives a wrong verdict. Phrase-only passes the hedge-then-answer case above.
 * Zero-citations-only cannot tell an abstention from a parse failure — `parseAnswerJson` returns
 * `citations: []` on any unparseable completion (src/answer/answer.ts:97-106) — which is why the
 * runner reports `json_parse_degraded` as its own count instead of letting it inflate this one.
 */
export function classifyAbstention(answer: string, citations: readonly number[]): AbstentionVerdict {
  if (!hasAbstentionPhrase(answer)) return 'answered';
  if (citations.length > 0) return 'partial';
  if (ASSERTION_PATTERNS.some((re) => re.test(answer))) return 'partial';
  return 'abstained';
}

/** Boolean convenience over `classifyAbstention`. `partial` is NOT an abstention. */
export function isAbstention(answer: string, citations: readonly number[]): boolean {
  return classifyAbstention(answer, citations) === 'abstained';
}

// ── Sampling ────────────────────────────────────────────────────────────────

/** mulberry32. Deterministic given a seed, which is the whole point: without it two runs draw
 *  different questions and a metric that moved could just be a different sample. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const UNTYPED = '__untyped__';

/**
 * A subset of `n` questions that preserves the per-type proportions.
 *
 * Stratification is not a nicety here. Null-type questions are ~12% of MultiHop-RAG, so a plain
 * random sample of 40 yields anywhere from 2 to 9 of them and the abstention rate computed from
 * either is noise. Proportional allocation makes small samples say something.
 *
 * Uses largest-remainder allocation so the total is EXACTLY n: naive rounding either drops questions
 * or overshoots, and a sample that is quietly 38 when the manifest says 40 is the kind of drift that
 * makes two runs incomparable. Groups that run out of members hand their shortfall back to groups
 * with capacity, so `n` is honoured whenever the population can honour it.
 */
export function stratifiedSample(
  questions: readonly EvalQuestion[],
  n: number,
  seed: number,
): EvalQuestion[] {
  if (n <= 0 || questions.length === 0) return [];
  if (n >= questions.length) return questions.slice();

  const groups = new Map<string, EvalQuestion[]>();
  for (const q of questions) {
    const key = q.type ?? UNTYPED;
    const g = groups.get(key);
    if (g) g.push(q);
    else groups.set(key, [q]);
  }

  // Deterministic group order — Map preserves insertion order, which depends on the input order,
  // which is the dataset's file order. Sorting makes the allocation independent of that.
  const keys = [...groups.keys()].sort();
  const total = questions.length;

  const exact = keys.map((k) => (groups.get(k)!.length * n) / total);
  const take = exact.map((e) => Math.floor(e));

  // Largest remainder, then capacity-aware redistribution of anything still unallocated.
  let remaining = n - take.reduce((a, b) => a + b, 0);
  const byRemainder = keys
    .map((_, i) => i)
    .sort((a, b) => exact[b]! - Math.floor(exact[b]!) - (exact[a]! - Math.floor(exact[a]!)) || a - b);
  for (const i of byRemainder) {
    if (remaining <= 0) break;
    if (take[i]! < groups.get(keys[i]!)!.length) {
      take[i]!++;
      remaining--;
    }
  }
  while (remaining > 0) {
    const grew = keys.some((k, i) => {
      if (remaining <= 0 || take[i]! >= groups.get(k)!.length) return false;
      take[i]!++;
      remaining--;
      return true;
    });
    if (!grew) break; // population exhausted
  }

  const rand = seededRandom(seed);
  const picked: EvalQuestion[] = [];
  for (let i = 0; i < keys.length; i++) {
    picked.push(...shuffled(groups.get(keys[i]!)!, rand).slice(0, take[i]!));
  }
  return picked;
}
