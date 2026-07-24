// The one door for every model call (DECISIONS D12). Every chat/embed/rerank routes here.
//
// Per-workspace binding via AsyncLocalStorage. We call providers over `fetch` (no cached SDK
// client), so there is no shared client that could carry one tenant's key into another tenant's
// request. Model calls MUST run inside withRouterScope — an unbound call throws rather than
// silently shipping without the workspace's ZDR (no-retention) preference (review sec S5).
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../config.ts';

export class RouterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouterError';
  }
}

interface RouterScope {
  workspaceId: string; // per-workspace binding; M5 spend caps key on this
  zdr: boolean;
}

const als = new AsyncLocalStorage<RouterScope>();
const CHAT_TIMEOUT_MS = 60_000;
const EMBED_TIMEOUT_MS = 30_000;
const MAX_ERR_BODY = 500;

/** Bind the router to a workspace for the duration of `fn`. */
export function withRouterScope<T>(scope: RouterScope, fn: () => Promise<T>): Promise<T> {
  return als.run(scope, fn);
}

/** Fail closed: a model call outside withRouterScope has no workspace/ZDR context. */
function requireScope(): RouterScope {
  const s = als.getStore();
  if (!s) throw new RouterError('model call made outside withRouterScope — bind a workspace scope first');
  return s;
}

/** Split a `provider:model` id. Colon wins over slash so OpenRouter's `org/model` ids survive. */
export function parseModelId(id: string): { provider: string; model: string } {
  const i = id.indexOf(':');
  if (i < 0) return { provider: 'openrouter', model: id };
  return { provider: id.slice(0, i), model: id.slice(i + 1) };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

async function errBody(res: Response): Promise<string> {
  return (await res.text()).slice(0, MAX_ERR_BODY);
}

/** fetch that maps a timeout/abort/network failure to a RouterError, so a caller (and dispatch's
 *  error sink) can tell "provider down / timed out" apart from a server bug — an unwrapped
 *  TimeoutError/TypeError would otherwise surface as a generic internal_error. */
async function routerFetch(url: string, init: RequestInit, provider: string): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (err instanceof RouterError) throw err;
    const name = (err as { name?: string } | null)?.name;
    if (name === 'TimeoutError') throw new RouterError(`${provider} request timed out`);
    if (name === 'AbortError') throw new RouterError(`${provider} request aborted`);
    throw new RouterError(`${provider} network error: ${(err as Error)?.message ?? String(err)}`);
  }
}

export async function chat(opts: { messages: ChatMessage[]; model?: string }): Promise<string> {
  const scope = requireScope();
  const modelId = opts.model || config.CHAT_MODEL;
  if (!modelId) {
    // Chat model is an OPEN decision (DECISIONS D12.1) — founder ruled out Anthropic (cost) and
    // OpenAI's chat models. Left unset on purpose so this fails loudly instead of defaulting.
    throw new RouterError(
      'no chat model configured — CHAT_MODEL is intentionally unset (see DECISIONS.md D12.1); ask the founder which provider before wiring a caller to chat()',
    );
  }
  const { provider, model } = parseModelId(modelId);
  if (provider !== 'openrouter') throw new RouterError(`chat provider not wired: ${provider}`);
  if (!config.OPENROUTER_API_KEY) throw new RouterError('OPENROUTER_API_KEY not set');

  const body: Record<string, unknown> = { model, messages: opts.messages };
  if (scope.zdr) body.provider = { data_collection: 'deny' }; // ZDR routing preference

  const res = await routerFetch(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    },
    'openrouter',
  );
  if (!res.ok) throw new RouterError(`openrouter ${res.status}: ${await errBody(res)}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = json.choices?.[0]?.message?.content;
  // Distinguish "no content" (tool-call-only, moderation refusal, finish_reason:length with null
  // content) from a real answer — returning '' would make a downstream caller treat it as success.
  if (content == null) throw new RouterError('openrouter returned no message content');
  return content;
}

export async function embed(texts: string[]): Promise<number[][]> {
  requireScope();
  const { provider, model } = parseModelId(config.EMBEDDING_MODEL);
  if (provider !== 'openai') throw new RouterError(`embed provider not wired: ${provider}`);
  if (!config.OPENAI_API_KEY) throw new RouterError('OPENAI_API_KEY not set');

  const res = await routerFetch(
    'https://api.openai.com/v1/embeddings',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model, input: texts }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    },
    'openai',
  );
  if (!res.ok) throw new RouterError(`openai ${res.status}: ${await errBody(res)}`);
  const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
  // Reorder by the provider's `index`, never positionally: OpenAI may return items out of input
  // order, and mapping positionally would store each chunk with another chunk's vector (silent
  // retrieval corruption). The count must also match 1:1 with the inputs.
  if (json.data.length !== texts.length) {
    throw new RouterError(`openai returned ${json.data.length} embeddings for ${texts.length} inputs`);
  }
  const vectors = [...json.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  // The vector(N) column and HNSW index are fixed at config.EMBEDDING_DIM (DECISIONS D13). A
  // provider/model returning a different width would silently fail at insert — catch it here.
  for (const v of vectors) {
    if (v.length !== config.EMBEDDING_DIM) {
      throw new RouterError(`embedding width ${v.length} != EMBEDDING_DIM ${config.EMBEDDING_DIM}`);
    }
  }
  return vectors;
}

// Reranker seam kept in v0 (DECISIONS D15); the implementation lands in M3.
export async function rerank(): Promise<never> {
  throw new RouterError('rerank seam not implemented yet (v0 reranker lands in M3)');
}
