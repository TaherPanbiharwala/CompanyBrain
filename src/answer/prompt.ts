// Prompt assembly for A17's answer step. Structure modeled on gbrain's src/core/think/prompt.ts
// (system instructions + numbered evidence blocks + structured-JSON output contract) under MIT —
// see NOTICE. Simplified: no takes/graph/trajectory blocks (no equivalent data model yet) — just
// numbered chunk blocks, since every citable unit here is a content_chunks row.
import type { ChunkHit } from '../search/hybrid.ts';

export const ANSWER_SYSTEM_PROMPT = `You are the company-brain answer assistant. Answer the user's question using ONLY the information in the <chunk> blocks provided — never use outside knowledge. Cite every substantive claim inline with its chunk number in brackets, e.g. "Revenue grew 40% [2]." If the chunks don't contain enough information to answer, say so plainly rather than guessing or fabricating.

Respond with a single JSON object and nothing else — no prose outside the JSON, no markdown code fence:
{"answer": "<your answer text, with inline [N] citations>", "citations": [<the chunk numbers you actually cited>]}`;

export function buildAnswerUserMessage(question: string, hits: readonly ChunkHit[]): string {
  const chunkBlocks = hits
    .map((hit, i) => `<chunk n="${i + 1}" page="${hit.slug}">\n${hit.content}\n</chunk>`)
    .join('\n\n');
  return `${chunkBlocks || '<no chunks retrieved>'}\n\nQuestion: ${question}\n\nRespond with the JSON object described in the system prompt.`;
}
