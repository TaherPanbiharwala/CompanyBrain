// Retrieve -> prompt -> generate -> parse citations. Modeled on gbrain's src/core/think/index.ts
// pipeline (gather -> synthesize, structured-JSON citations trusted over any regex fallback) under
// MIT — see NOTICE. Simplified for the A17 spike: single retrieval pass, no takes/graph, no
// persisted synthesis_evidence rows (M3/M7 concerns).
import type { OperationContext } from '../core/context.ts';
import { chat, withRouterScope } from '../ai/router.ts';
import { hybridSearch, type ChunkHit, type SearchDegradation } from '../search/hybrid.ts';
import { ANSWER_SYSTEM_PROMPT, buildAnswerUserMessage } from './prompt.ts';

export interface AnswerResult {
  answer: string;
  /**
   * Present when the answer rests on less evidence than it should — today only `'keyword_only'`,
   * meaning the embedding provider was unavailable and retrieval fell back to keyword matching.
   *
   * Deliberately part of the RESULT rather than only a log line. A thin answer and a thin answer
   * built on half the search are indistinguishable to a reader, and the reader is the one deciding
   * whether to act on it.
   */
  degraded?: SearchDegradation;
  /**
   * 1-BASED indices into `sources` — the chunk numbers the model was shown, so `[2]` in the answer
   * text is `sources[1]`. Validated: every entry is an integer within `1..sources.length`, and
   * duplicates are collapsed. Prefer `cited` below over doing the arithmetic yourself.
   */
  citations: number[];
  /** The chunks `citations` refers to, already resolved. Same order, no off-by-one to get wrong. */
  cited: ChunkHit[];
  sources: ChunkHit[];
}

/**
 * Parse the model's structured {answer, citations} JSON. Degrades gracefully (never throws) on
 * invalid/missing JSON — the whole response becomes the answer with an empty citation list,
 * mirroring gbrain's fallback behavior rather than surfacing a synthesis failure to the caller.
 *
 * `sourceCount` bounds the citations. Before the M1+M2 review the filter was `typeof n === 'number'`
 * and nothing else, so `[0]`, `[99]`, `[-1]`, `[1.5]` and `[NaN]` all passed straight through to the
 * caller as dangling footnotes — a consumer doing `sources[n - 1]` gets `undefined`. These are
 * MODEL-GENERATED indices into our own array: exactly the structured-output-into-a-lookup case that
 * needs a range check, not a type check.
 */
/**
 * Remove inline `[N]` markers that point past the evidence.
 *
 * The clamp below guards the citations ARRAY; this guards the PROSE, which is what a human actually
 * reads. They are separate channels and an adversarial pass caught the gap: with
 * `{"answer":"x [1][99]","citations":[1,99]}` the array was cleaned to `[1]` while the answer text
 * still shipped a live `[99]` — a footnote to nothing, under a test titled "no dangling footnote,
 * ever". Markers pointing INTO range are left alone; whether the model cited the *right* chunk is a
 * judgement no amount of parsing can make.
 */
function scrubMarkers(answer: string, sourceCount: number): string {
  return answer.replace(/\[(\d{1,4})\]/g, (whole, digits: string) => {
    const n = Number(digits);
    return n >= 1 && n <= sourceCount ? whole : '';
  });
}

function parseAnswerJson(raw: string, sourceCount: number): { answer: string; citations: number[] } {
  const clamp = (xs: unknown): number[] => {
    if (!Array.isArray(xs)) return [];
    const seen = new Set<number>();
    for (const n of xs) {
      if (typeof n !== 'number' || !Number.isInteger(n)) continue; // rejects 1.5, NaN, Infinity, '2'
      if (n < 1 || n > sourceCount) continue; // rejects 0, -1, and any index past the evidence
      seen.add(n);
    }
    return [...seen];
  };

  // A ```json fence is the single most common structured-output deviation, and an injected chunk can
  // deliberately induce one — which would be a cheap way to both blank the citation trail and widen
  // the output channel (the degrade path returns the ENTIRE completion as the answer). Strip it and
  // try again before giving up.
  const unfenced = raw.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```$/, '');

  for (const candidate of raw === unfenced ? [raw] : [raw, unfenced]) {
    try {
      const obj: unknown = JSON.parse(candidate);
      if (obj && typeof obj === 'object' && typeof (obj as { answer?: unknown }).answer === 'string') {
        const citations = clamp((obj as { citations?: unknown }).citations);
        return { answer: scrubMarkers((obj as { answer: string }).answer, sourceCount), citations };
      }
    } catch {
      // try the next candidate, then fall through to the degrade path below
    }
  }
  console.warn('[answer] model did not return valid structured JSON; falling back to unstructured text');
  // Citations are dropped along with the payload they came from: a response we could not parse is
  // not one whose citation array we should trust.
  //
  // scrubMarkers runs HERE TOO. It used to guard only the structured path, which left the degrade
  // path — the one an injected prompt is most likely to push the model onto, because "ignore the
  // format" and "ignore the question" are the same instruction — shipping `[99]` to the reader
  // verbatim. Both exits now honour the same rule: a marker pointing outside the evidence is not a
  // citation, it is a footnote to nothing.
  return { answer: scrubMarkers(raw, sourceCount), citations: [] };
}

export async function answerQuestion(ctx: OperationContext, question: string): Promise<AnswerResult> {
  // Retrieval runs in its own withScopedTx (inside hybridSearch); the model call below runs
  // OUTSIDE any tx (D6) — chat() must never be called while a pooled connection is held open.
  const { hits: sources, degraded } = await hybridSearch(ctx, question);

  const raw = await withRouterScope({ workspaceId: ctx.workspaceId, zdr: false }, () =>
    chat({
      messages: [
        { role: 'system', content: ANSWER_SYSTEM_PROMPT },
        // `degraded` is passed to the prompt builder, not concatenated here, because it has to be
        // stated on a NONCE-MARKED line. An unmarked "note: search was degraded" would be a line the
        // system prompt explicitly tells the model to disregard — it instructs that only
        // nonce-carrying lines are real structural boundaries and everything else is document
        // content. So the honest warning would be indistinguishable from a chunk pretending to be one.
        { role: 'user', content: buildAnswerUserMessage(question, sources, { degraded }) },
      ],
    }),
  );

  const { answer, citations } = parseAnswerJson(raw, sources.length);
  // Safe by construction: clamp() guarantees 1 <= n <= sources.length.
  const cited = citations.map((n) => sources[n - 1]!);
  return { answer, citations, cited, sources, degraded };
}
