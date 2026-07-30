// The one door for every model call (DECISIONS D12). Every chat/embed/rerank routes here.
//
// Per-workspace binding via AsyncLocalStorage. We call providers over `fetch` (no cached SDK
// client), so there is no shared client that could carry one tenant's key into another tenant's
// request. Model calls MUST run inside withRouterScope — an unbound call throws rather than
// silently shipping without the workspace's ZDR (no-retention) preference (review sec S5).
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../config.ts';

/** A provider failure, with enough structure to decide what to do about it.
 *
 *  The message used to be the ONLY carrier: `openai 429: rate limit exceeded`. That reads fine and is
 *  useless to code — a backoff layer cannot tell 429 from 400 by substring, cannot read `retry-after`,
 *  and cannot tell a rate limit (retry) from `insufficient_quota` (never retry, the card is declined).
 *  Retrying a permanently-failing call three times just multiplies a 60s timeout into three minutes of
 *  user-visible latency before the same error. So status/headers are lifted out of the prose. */
export class RouterError extends Error {
  /** HTTP status when the provider answered; undefined for a network error or timeout. */
  readonly status?: number;
  /** From `retry-after` or `x-ratelimit-reset-*`, in ms. Honour it over computed backoff. */
  readonly retryAfterMs?: number;
  /** Provider-specific machine code, e.g. `insufficient_quota`. */
  readonly providerCode?: string;
  /** Timeouts and network errors are retryable even with no status. */
  readonly transport?: 'timeout' | 'abort' | 'network';

  constructor(
    message: string,
    opts: { status?: number; retryAfterMs?: number; providerCode?: string; transport?: RouterError['transport'] } = {},
  ) {
    super(message);
    this.name = 'RouterError';
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.providerCode = opts.providerCode;
    this.transport = opts.transport;
  }

  /** Worth trying again. 429 and 5xx are transient; so is anything that never reached the provider.
   *  A quota exhaustion is a 429 that will NEVER succeed, which is why providerCode is checked first —
   *  treating it as a rate limit is how a declined card becomes three minutes of retries. */
  get retryable(): boolean {
    if (this.providerCode === 'insufficient_quota') return false;
    if (this.transport) return true;
    if (this.status === undefined) return false;
    return this.status === 429 || this.status === 408 || this.status >= 500;
  }
}

interface RouterScope {
  workspaceId: string; // per-workspace binding; M5 spend caps key on this
  zdr: boolean;
}

const als = new AsyncLocalStorage<RouterScope>();
const CHAT_TIMEOUT_MS = 60_000;
// 60s, not 30s: a full embedding batch over an intercontinental link plus provider queueing does not
// reliably land inside 30s, and a timeout here costs the caller the whole ingest after chunking.
const EMBED_TIMEOUT_MS = 60_000;
const MAX_ERR_BODY = 500;

// Retry budget. Bounded by ELAPSED time, not attempt count: attempts × timeout is the number a user
// actually waits, and three attempts at 60s is three minutes of silence for a request that was never
// going to succeed.
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 400;
const RETRY_MAX_ELAPSED_MS = 45_000;

/** A provider's error body is THIRD-PARTY TEXT that ends up inside a RouterError message, and that
 *  message is printed by the terminal error middleware into a stream of JSON log lines. A body
 *  containing a newline followed by `{"level":"info","kind":"auth",...}` would therefore append a
 *  forged record to that stream — the same frame-injection shape as the prompt-injection finding,
 *  one layer down. Newlines and control characters are what make the forgery possible, so they are
 *  what gets flattened; the readable text survives, which is the whole point of logging it.
 *
 *  Deliberately NOT dropped entirely: `insufficient credits`, `model not found` and `context length
 *  exceeded` are the messages that make a 500 diagnosable, and none of them is our data. */
function flattenProviderBody(body: string): string {
  return body
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ERR_BODY);
}

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

/** fetch + status-check + json-parse, ALL inside one try/catch. A timeout/abort can fire while
 *  reading the response body (a slow/streamed completion) just as easily as during the initial
 *  connection — wrapping only the fetch() call (as an earlier version of this did) let a bare
 *  DOMException{name:'TimeoutError'} escape from res.json()/res.text() uncaught (observed live
 *  during the A17 eval run). Every failure mode here — connect timeout, body-read timeout, abort,
 *  network error, non-2xx status — becomes one catchable RouterError. */
/** `retry-after` is seconds or an HTTP-date; the reset headers are seconds or ms depending on vendor.
 *  Anything unparseable yields undefined so the caller falls back to computed backoff. */
function parseRetryAfter(headers: Headers): number | undefined {
  const ra = headers.get('retry-after');
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const when = Date.parse(ra);
    if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  }
  const reset = headers.get('x-ratelimit-reset-requests') ?? headers.get('x-ratelimit-reset-tokens');
  if (reset) {
    const m = /^([\d.]+)(ms|s)?$/.exec(reset.trim());
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) return m[2] === 'ms' ? n : n * 1000;
    }
  }
  return undefined;
}

/** Providers nest their machine code differently; both shapes seen in the wild. */
function providerCodeOf(body: string): string | undefined {
  try {
    const j = JSON.parse(body) as { error?: { code?: unknown; type?: unknown }; code?: unknown };
    const c = j.error?.code ?? j.error?.type ?? j.code;
    return typeof c === 'string' ? c : undefined;
  } catch {
    return undefined;
  }
}

async function fetchOnce(url: string, init: RequestInit, provider: string, timeoutMs: number): Promise<unknown> {
  try {
    // The signal is built HERE, per attempt, not once by the caller.
    //
    // It used to be `signal: AbortSignal.timeout(...)` in the init object that fetchJson reuses for
    // all three attempts — so the deadline was shared. Once it fired, attempts 2 and 3 aborted
    // instantly, and because `transport:'abort'` counts as retryable the loop still slept its full
    // jitter backoff before each no-op. The retry layer could not help with a timeout, which is the
    // single failure it was added for; it only added latency.
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      const raw = await res.text();
      throw new RouterError(`${provider} ${res.status}: ${flattenProviderBody(raw)}`, {
        status: res.status,
        retryAfterMs: parseRetryAfter(res.headers),
        providerCode: providerCodeOf(raw),
      });
    }
    return await res.json();
  } catch (err) {
    if (err instanceof RouterError) throw err;
    const name = (err as { name?: string } | null)?.name;
    if (name === 'TimeoutError') throw new RouterError(`${provider} request timed out`, { transport: 'timeout' });
    if (name === 'AbortError') throw new RouterError(`${provider} request aborted`, { transport: 'abort' });
    throw new RouterError(`${provider} network error: ${(err as Error)?.message ?? String(err)}`, {
      transport: 'network',
    });
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** fetch + status-check + json-parse + RETRY, all inside one try/catch. A timeout/abort can fire while
 *  reading the response body (a slow/streamed completion) just as easily as during the initial
 *  connection — wrapping only the fetch() call (as an earlier version of this did) let a bare
 *  DOMException{name:'TimeoutError'} escape from res.json()/res.text() uncaught (observed live during
 *  the A17 eval run). Every failure mode here becomes one catchable RouterError.
 *
 *  RETRY LIVES HERE, and only here, for two reasons.
 *
 *  It has to be this low or the `ask` path misses it: the query embedding at search time goes through
 *  the same function as the ingest embedding, and a retry layer wrapped around ingest alone would
 *  leave the request a user actually waits on unprotected.
 *
 *  And it must not be any higher: a retry around a MUTATING operation re-sends a request whose first
 *  attempt may have succeeded with only the response lost. Embeddings and completions are pure reads
 *  of a model — re-sending costs money and nothing else. Never lift this to wrap an op. */
async function fetchJson(url: string, init: RequestInit, provider: string, timeoutMs: number): Promise<unknown> {
  const startedAt = Date.now();
  let lastErr: RouterError | undefined;

  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      // Each attempt gets its OWN deadline, and the remaining elapsed budget caps it so a retry
      // cannot outlive RETRY_MAX_ELAPSED_MS just because its per-attempt timeout is generous.
      const remaining = RETRY_MAX_ELAPSED_MS - (Date.now() - startedAt);
      if (remaining <= 0) throw lastErr ?? new RouterError(`${provider} retry budget exhausted`, { transport: 'timeout' });
      return await fetchOnce(url, init, provider, Math.min(timeoutMs, remaining));
    } catch (err) {
      const e = err instanceof RouterError ? err : new RouterError(String(err));
      lastErr = e;
      if (!e.retryable || attempt === RETRY_MAX_ATTEMPTS) throw e;

      // Full jitter: without it, N chunk batches that rate-limited together retry together and
      // rate-limit together again.
      const backoff = Math.min(8_000, RETRY_BASE_MS * 2 ** (attempt - 1));
      const wait = e.retryAfterMs ?? Math.random() * backoff;
      if (Date.now() - startedAt + wait > RETRY_MAX_ELAPSED_MS) throw e;

      console.warn(
        `[router] ${provider} attempt ${attempt}/${RETRY_MAX_ATTEMPTS} failed (${e.status ?? e.transport}); retrying in ${Math.round(wait)}ms`,
      );
      await sleep(wait);
    }
  }
  throw lastErr ?? new RouterError(`${provider} failed`);
}

export async function chat(opts: { messages: ChatMessage[]; model?: string }): Promise<string> {
  const scope = requireScope();
  const modelId = opts.model || config.CHAT_MODEL;
  if (!modelId) {
    // The chat model IS chosen — DeepSeek via OpenRouter (DECISIONS D12.1); it is simply not set in
    // this environment. It has no code default on purpose: silently defaulting would spend money on
    // a provider the operator did not pick, and Anthropic/OpenAI chat models are explicitly ruled
    // out on cost, so a wrong default is a wrong bill.
    throw new RouterError(
      'no chat model configured — set CHAT_MODEL in .env. The chosen model is openrouter:deepseek/deepseek-v4-flash (DECISIONS.md D12.1); see .env.example.',
    );
  }
  const { provider, model } = parseModelId(modelId);
  if (provider !== 'openrouter') throw new RouterError(`chat provider not wired: ${provider}`);
  if (!config.OPENROUTER_API_KEY) throw new RouterError('OPENROUTER_API_KEY not set');

  const body: Record<string, unknown> = { model, messages: opts.messages };
  // ZDR routing preference. NOT REACHABLE YET, stated plainly because D12 and .env.example both
  // describe it as a live per-workspace toggle: every call site (answer.ts, hybrid.ts, import.ts)
  // hardcodes `zdr: false`, so `data_collection: 'deny'` has never been sent to a provider. The
  // plumbing below is correct and tested; what is missing is the workspace column and the UI that
  // sets it, which is M5. Until then, treat "we support ZDR" as FALSE when talking to a customer.
  if (scope.zdr) body.provider = { data_collection: 'deny' };

  const json = (await fetchJson(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    'openrouter',
    CHAT_TIMEOUT_MS,
  )) as { choices?: { message?: { content?: string } }[] };
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

  const json = (await fetchJson(
    'https://api.openai.com/v1/embeddings',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model, input: texts }),
    },
    'openai',
    EMBED_TIMEOUT_MS,
  )) as { data: { index: number; embedding: number[] }[] };
  // Place each vector at the position its `index` names, never positionally and never by sorting:
  // OpenAI may return items out of input order, and reading them in arrival order would store each
  // chunk with another chunk's vector — silent retrieval corruption with no error anywhere.
  //
  // ASSIGNMENT, not sort-then-map, and the difference is not cosmetic. `sort().map()` turns a
  // DUPLICATED index into a silent collapse: with indices [0, 0, 2] it produces three vectors, the
  // count check below passes because the count is right, and input 1 is never embedded while input 0
  // is stored twice. Assigning into a preallocated array leaves a hole instead, which is detectable.
  if (json.data.length !== texts.length) {
    throw new RouterError(`openai returned ${json.data.length} embeddings for ${texts.length} inputs`);
  }
  // Slot ASSIGNMENT, not sort-then-map. Both branches fixed this independently and the merge keeps
  // the stronger one, so the reasoning from each is recorded here.
  //
  // The original mapped positionally. Sorting by `index` was the first fix, and it is not enough:
  // `undefined - undefined` is NaN and a NaN comparator leaves the array untouched, so a provider
  // that OMITTED the field silently gave back exactly the positional mapping the sort existed to
  // prevent. Asserting the field is an integer closes that.
  //
  // But a DUPLICATED index survives both: [0,0,2] sorts to three vectors, the count check passes,
  // input 1 is never embedded and input 0 is stored twice. Assigning into preallocated slots is what
  // makes that observable — the duplicate overwrites one slot and leaves a hole in another, and the
  // hole is the only trace. The failure it prevents is every chunk stored under another chunk's
  // vector, discoverable months later as bad answers and nothing else.
  const slots = new Array<number[] | undefined>(texts.length);
  for (const d of json.data) {
    if (!Number.isInteger(d.index) || d.index < 0 || d.index >= texts.length) {
      throw new RouterError(`openai returned index ${d.index} for a ${texts.length}-input request`);
    }
    slots[d.index] = d.embedding;
  }
  const missing = slots.findIndex((v) => v === undefined);
  if (missing !== -1) {
    throw new RouterError(
      `openai returned no embedding for input ${missing} — an index was duplicated, so one input was embedded twice and this one not at all`,
    );
  }
  const vectors = slots as number[][];
  // The vector(N) column and HNSW index are fixed at config.EMBEDDING_DIM (DECISIONS D13). A
  // provider/model returning a different width would silently fail at insert — catch it here.
  for (const v of vectors) {
    if (v.length !== config.EMBEDDING_DIM) {
      throw new RouterError(`embedding width ${v.length} != EMBEDDING_DIM ${config.EMBEDDING_DIM}`);
    }
  }
  return vectors;
}

// ── Reranking (D15's seam, now with a real signature) ──────────────────────

export interface RerankItem {
  /** Opaque to the router — echoed back so the caller can map scores to its own rows. */
  id: string;
  text: string;
}

export interface RerankScore {
  id: string;
  /** Provider-scaled relevance. Comparable within one call only, like an RRF score. */
  score: number;
}

/** Whether a reranker is configured at all. Callers check this INSTEAD of catching a throw, so
 *  "turned off" and "misconfigured" stay distinguishable — a swallowed exception would make a typo
 *  in RERANK_MODEL look exactly like the default. */
export function isRerankEnabled(): boolean {
  return config.RERANK_MODEL.trim() !== '';
}

const RERANK_TIMEOUT_MS = 30_000;

/**
 * Re-score `items` against `query` with a cross-encoder, returning them ordered best-first.
 *
 * Routed through the same scope check as chat and embed, so a rerank call cannot escape a
 * workspace's ZDR preference — the item texts are tenant content and this is a third provider
 * seeing them.
 *
 * NOT VERIFIED AGAINST A LIVE PROVIDER. The wire shape below follows Cohere's documented v2 rerank
 * API, and test/embed-batch.test.ts exercises this plumbing through a stubbed fetch — so what is tested
 * is that the request is well-formed, that indices are mapped back correctly, and that the seam
 * refuses to run when unconfigured. Whether Cohere's live contract still matches is not something a
 * test in this repo can currently claim, and it is off by default.
 */
export async function rerank(query: string, items: RerankItem[]): Promise<RerankScore[]> {
  requireScope();
  if (!isRerankEnabled()) {
    throw new RouterError('rerank called with no RERANK_MODEL configured — check isRerankEnabled() first');
  }
  if (items.length === 0) return [];

  const { provider, model } = parseModelId(config.RERANK_MODEL);
  if (provider !== 'cohere') throw new RouterError(`rerank provider not wired: ${provider}`);
  const key = process.env.COHERE_API_KEY ?? '';
  if (!key) throw new RouterError('COHERE_API_KEY not set but RERANK_MODEL names cohere');

  const json = (await fetchJson(
    'https://api.cohere.com/v2/rerank',
    {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, query, documents: items.map((i) => i.text) }),
    },
    'cohere',
    RERANK_TIMEOUT_MS,
  )) as { results?: { index: number; relevance_score: number }[] };

  const results = json.results ?? [];
  // Same trap as embed(): `index` is the provider's reference into the array WE sent, and it is not
  // necessarily positional in the response — rerank responses are typically returned already sorted
  // by score, so reading them positionally would map every score to the wrong document. An index
  // outside range is dropped rather than trusted; it would otherwise index `items` to undefined and
  // surface as a chunk id of `undefined` in the caller's map.
  return results
    .filter((r) => Number.isInteger(r.index) && r.index >= 0 && r.index < items.length)
    .map((r) => ({ id: items[r.index]!.id, score: r.relevance_score }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ── Query expansion (config-gated, default off) ────────────────────────────

/** Whether multi-query expansion is switched on. */
export function isExpansionEnabled(): boolean {
  return config.QUERY_EXPANSION === 1;
}

const EXPANSION_MAX = 3;

/**
 * Ask the chat model for a few paraphrases of `question`, to widen the keyword arm's vocabulary.
 *
 * Returns `[]` on ANY failure, deliberately. Expansion is an enhancement on the ask path; letting a
 * paraphrase call fail the user's actual question would be the tail wagging the dog, and the
 * unexpanded query is a perfectly good query.
 *
 * The output is treated as UNTRUSTED TEXT downstream: it is fed to keywordQueryText, which strips
 * everything outside `[a-z0-9]`. That matters because this is model output being spliced into a
 * search query — not attacker-controlled in the usual sense, but not something to concatenate into
 * SQL either, and it never is (it becomes a bind parameter).
 */
export async function expandQuery(question: string): Promise<string[]> {
  if (!isExpansionEnabled()) return [];
  try {
    const raw = await chat({
      messages: [
        {
          role: 'system',
          content:
            `Rewrite the user's question as up to ${EXPANSION_MAX} alternative phrasings that a document might ` +
            'use instead. Vary the vocabulary, keep the meaning. Reply with a JSON array of strings and nothing else.',
        },
        { role: 'user', content: question },
      ],
    });
    const parsed: unknown = JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```$/, ''));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === 'string' && s.length > 0).slice(0, EXPANSION_MAX);
  } catch {
    return [];
  }
}
