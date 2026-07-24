// Retrieve -> prompt -> generate -> parse citations. Modeled on gbrain's src/core/think/index.ts
// pipeline (gather -> synthesize, structured-JSON citations trusted over any regex fallback) under
// MIT — see NOTICE. Simplified for the A17 spike: single retrieval pass, no takes/graph, no
// persisted synthesis_evidence rows (M3/M7 concerns).
import type { OperationContext } from '../core/context.ts';
import { chat, withRouterScope } from '../ai/router.ts';
import { hybridSearch, type ChunkHit } from '../search/hybrid.ts';
import { ANSWER_SYSTEM_PROMPT, buildAnswerUserMessage } from './prompt.ts';

export interface AnswerResult {
  answer: string;
  citations: number[];
  sources: ChunkHit[];
}

/** Parse the model's structured {answer, citations} JSON. Degrades gracefully (never throws) on
 *  invalid/missing JSON — the whole response becomes the answer with an empty citation list,
 *  mirroring gbrain's fallback behavior rather than surfacing a synthesis failure to the caller. */
function parseAnswerJson(raw: string): { answer: string; citations: number[] } {
  try {
    const obj: unknown = JSON.parse(raw);
    if (obj && typeof obj === 'object' && typeof (obj as { answer?: unknown }).answer === 'string') {
      const rawCitations = (obj as { citations?: unknown }).citations;
      const citations = Array.isArray(rawCitations) ? rawCitations.filter((n): n is number => typeof n === 'number') : [];
      return { answer: (obj as { answer: string }).answer, citations };
    }
  } catch {
    // fall through to the degrade path below
  }
  console.warn('[answer] model did not return valid structured JSON; falling back to unstructured text');
  return { answer: raw, citations: [] };
}

export async function answerQuestion(ctx: OperationContext, question: string): Promise<AnswerResult> {
  // Retrieval runs in its own withScopedTx (inside hybridSearch); the model call below runs
  // OUTSIDE any tx (D6) — chat() must never be called while a pooled connection is held open.
  const sources = await hybridSearch(ctx, question);

  const raw = await withRouterScope({ workspaceId: ctx.workspaceId, zdr: false }, () =>
    chat({
      messages: [
        { role: 'system', content: ANSWER_SYSTEM_PROMPT },
        { role: 'user', content: buildAnswerUserMessage(question, sources) },
      ],
    }),
  );

  const { answer, citations } = parseAnswerJson(raw);
  return { answer, citations, sources };
}
