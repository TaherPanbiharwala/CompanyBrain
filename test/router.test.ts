import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { parseModelId, chat, embed, RouterError, withRouterScope } from '../src/ai/router.ts';
import { config } from '../src/config.ts';

// config is `as const` in TS but a plain (mutable) object at runtime; tests set a key then restore it.
const mutableConfig = config as unknown as Record<string, unknown>;
const scoped = <T>(fn: () => Promise<T>) => withRouterScope({ workspaceId: crypto.randomUUID(), zdr: false }, fn);
const okJson = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });

describe('parseModelId', () => {
  it('defaults provider to openrouter when there is no colon', () => {
    expect(parseModelId('qwen/qwen-2.5')).toEqual({ provider: 'openrouter', model: 'qwen/qwen-2.5' });
  });
  it('colon wins over slash (OpenRouter org/model ids survive)', () => {
    expect(parseModelId('openrouter:org/model')).toEqual({ provider: 'openrouter', model: 'org/model' });
  });
  it('handles an empty string without throwing', () => {
    expect(parseModelId('')).toEqual({ provider: 'openrouter', model: '' });
  });
});

describe('router scope binding (fail closed)', () => {
  it('chat() throws when called outside withRouterScope', async () => {
    await expect(chat({ messages: [{ role: 'user', content: 'hi' }], model: 'openrouter:org/model' }))
      .rejects.toThrow(RouterError);
  });
});

// D12.1: chat model is intentionally unset — chat() must throw rather than default to a provider.
// Skips if someone has actually configured CHAT_MODEL (bun test auto-loads .env).
describe.skipIf(!!config.CHAT_MODEL)('chat model intentionally unset (DECISIONS D12.1)', () => {
  it('throws RouterError instead of defaulting to Anthropic/OpenAI', async () => {
    await expect(
      withRouterScope({ workspaceId: crypto.randomUUID(), zdr: false }, () =>
        chat({ messages: [{ role: 'user', content: 'hi' }] })),
    ).rejects.toThrow(RouterError);
  });
});

describe('embed — order by provider index, never positionally', () => {
  const realFetch = globalThis.fetch;
  const realKey = mutableConfig.OPENAI_API_KEY;
  const vec = (fill: number) => new Array(config.EMBEDDING_DIM).fill(fill);
  beforeAll(() => {
    mutableConfig.OPENAI_API_KEY = 'test-key';
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
    mutableConfig.OPENAI_API_KEY = realKey;
  });

  it('reorders embeddings by data[].index (out-of-order response)', async () => {
    // 'a' is input index 0 → its vector is filled with 1; the provider returns it SECOND.
    globalThis.fetch = (async () =>
      okJson({ data: [{ index: 1, embedding: vec(2) }, { index: 0, embedding: vec(1) }] })) as unknown as typeof fetch;
    const out = await scoped(() => embed(['a', 'b']));
    expect(out[0]?.[0]).toBe(1); // input 'a' keeps ITS vector despite arriving second
    expect(out[1]?.[0]).toBe(2);
  });

  it('count mismatch → RouterError (never silently drops a chunk)', async () => {
    globalThis.fetch = (async () => okJson({ data: [{ index: 0, embedding: vec(1) }] })) as unknown as typeof fetch;
    await expect(scoped(() => embed(['a', 'b']))).rejects.toThrow(RouterError);
  });
});

describe('chat — no-content and network failures surface as RouterError', () => {
  const realFetch = globalThis.fetch;
  const realKey = mutableConfig.OPENROUTER_API_KEY;
  beforeAll(() => {
    mutableConfig.OPENROUTER_API_KEY = 'test-key';
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
    mutableConfig.OPENROUTER_API_KEY = realKey;
  });

  it('missing message content → RouterError, not an empty string', async () => {
    globalThis.fetch = (async () => okJson({ choices: [{ message: {} }] })) as unknown as typeof fetch;
    await expect(scoped(() => chat({ messages: [{ role: 'user', content: 'hi' }], model: 'openrouter:x/y' })))
      .rejects.toThrow(RouterError);
  });

  it('a network/timeout failure is mapped to RouterError (not a raw TypeError)', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(scoped(() => chat({ messages: [{ role: 'user', content: 'hi' }], model: 'openrouter:x/y' })))
      .rejects.toThrow(RouterError);
  });

  it('a timeout firing DURING body read (fetch() already resolved ok) is still mapped to RouterError', async () => {
    // Regression: an earlier version only wrapped the fetch() call itself, so an AbortSignal
    // firing while streaming/parsing the response body (res.json()) let a raw DOMException
    // escape uncaught — observed live during the A17 eval run against a real slow completion.
    globalThis.fetch = (async () => ({
      ok: true,
      json: () => Promise.reject(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' })),
    })) as unknown as typeof fetch;
    await expect(scoped(() => chat({ messages: [{ role: 'user', content: 'hi' }], model: 'openrouter:x/y' })))
      .rejects.toThrow(RouterError);
  });
});

// ── Retry policy ──────────────────────────────────────────────────────────
// The router is the ONLY place that retries, and it retries a provider call — never an operation.
// These pin the two decisions that cost real money if they invert: a rate limit must be retried, and
// an exhausted quota must NOT be (it is a 429 that will never succeed, so retrying it converts a
// declined card into minutes of user-visible latency before the same error).
describe('fetchJson retry policy', () => {
  const realFetch = globalThis.fetch;
  const realKey = mutableConfig.OPENAI_API_KEY;
  const vec = (fill: number) => new Array(config.EMBEDDING_DIM).fill(fill);
  beforeAll(() => { mutableConfig.OPENAI_API_KEY = 'test-key'; });
  afterAll(() => { globalThis.fetch = realFetch; mutableConfig.OPENAI_API_KEY = realKey; });

  it('retries a 429 and succeeds on a later attempt', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls < 3) {
        // retry-after in seconds; 0 keeps the test fast while still exercising the header path.
        return new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }), {
          status: 429,
          headers: { 'retry-after': '0' },
        });
      }
      return okJson({ data: [{ index: 0, embedding: vec(1) }] });
    }) as unknown as typeof fetch;

    const out = await scoped(() => embed(['a']));
    expect(out[0]?.[0]).toBe(1);
    expect(calls).toBe(3);
  }, 20_000);

  it('does NOT retry insufficient_quota — a declined card is not a rate limit', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: { code: 'insufficient_quota' } }), { status: 429 });
    }) as unknown as typeof fetch;

    await expect(scoped(() => embed(['a']))).rejects.toThrow(RouterError);
    expect(calls, 'insufficient_quota must fail on the first attempt').toBe(1);
  }, 20_000);

  it('does NOT retry a 400 — a malformed request will be malformed again', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: { code: 'invalid_request_error' } }), { status: 400 });
    }) as unknown as typeof fetch;

    await expect(scoped(() => embed(['a']))).rejects.toThrow(RouterError);
    expect(calls).toBe(1);
  }, 20_000);

  it('carries status and providerCode on the error, not only in the message', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { code: 'insufficient_quota' } }), { status: 429 })) as unknown as typeof fetch;

    const err = await scoped(() => embed(['a'])).then(() => null, (e: RouterError) => e);
    expect(err).toBeInstanceOf(RouterError);
    expect(err!.status).toBe(429);
    expect(err!.providerCode).toBe('insufficient_quota');
    expect(err!.retryable, 'quota exhaustion is terminal').toBe(false);
  }, 20_000);
});
