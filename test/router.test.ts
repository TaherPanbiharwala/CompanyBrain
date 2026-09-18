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

// ── Cycle-engine (M8) budget hook ───────────────────────────────────────────
// RouterScope.budget is optional and set ONLY by runner-context.ts (src/core/cycle). Every test
// above calls scoped() with no budget field, so those already prove the additive case: no hook
// means chat()/embed() behave exactly as before M8. These prove the hook actually fires, with the
// right shape, when a caller (the cycle engine) does supply one.
describe('router — cycle-engine budget hook (M8)', () => {
  const realFetch = globalThis.fetch;
  const realOpenAiKey = mutableConfig.OPENAI_API_KEY;
  const realOpenRouterKey = mutableConfig.OPENROUTER_API_KEY;
  const vec = (fill: number) => new Array(config.EMBEDDING_DIM).fill(fill);
  beforeAll(() => {
    mutableConfig.OPENAI_API_KEY = 'test-key';
    mutableConfig.OPENROUTER_API_KEY = 'test-key';
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
    mutableConfig.OPENAI_API_KEY = realOpenAiKey;
    mutableConfig.OPENROUTER_API_KEY = realOpenRouterKey;
  });

  it('embed() calls check() before the provider call and record() after, in order', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async () => {
      calls.push('fetch');
      return okJson({ data: [{ index: 0, embedding: vec(1) }], usage: { prompt_tokens: 7 } });
    }) as unknown as typeof fetch;

    const budget = {
      check: async (estimate: { kind: string; estimatedInputTokens: number }) => {
        calls.push('check');
        expect(estimate.kind).toBe('embed');
        expect(estimate.estimatedInputTokens).toBeGreaterThan(0);
        return { allowed: true, estimatedCostUsd: 0.001, cumulativeCostUsd: 0.001, budgetUsd: 1 };
      },
      record: async (actual: { kind: string; inputTokens: number }) => {
        calls.push('record');
        expect(actual.kind).toBe('embed');
        expect(actual.inputTokens).toBe(7); // pulled from the provider's own usage.prompt_tokens
      },
    };

    await withRouterScope({ workspaceId: crypto.randomUUID(), zdr: false, budget }, () => embed(['hello world']));
    expect(calls).toEqual(['check', 'fetch', 'record']);
  });

  it('embed() propagates a denial from check() and never calls fetch or record', async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return okJson({ data: [] });
    }) as unknown as typeof fetch;

    const budget = {
      check: async () => {
        throw new Error('budget exhausted');
      },
      record: async () => {
        throw new Error('record should never be called after a denied check()');
      },
    };

    await expect(
      withRouterScope({ workspaceId: crypto.randomUUID(), zdr: false, budget }, () => embed(['hello'])),
    ).rejects.toThrow('budget exhausted');
    expect(fetchCalled).toBe(false);
  });

  it('chat() calls check() before the provider call and record() after, in order', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async () => {
      calls.push('fetch');
      return okJson({ choices: [{ message: { content: 'hi there' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } });
    }) as unknown as typeof fetch;

    const budget = {
      check: async (estimate: { kind: string }) => {
        calls.push('check');
        expect(estimate.kind).toBe('chat');
        return { allowed: true, estimatedCostUsd: 0.001, cumulativeCostUsd: 0.001, budgetUsd: 1 };
      },
      record: async (actual: { kind: string; inputTokens: number; outputTokens?: number }) => {
        calls.push('record');
        expect(actual.kind).toBe('chat');
        expect(actual.inputTokens).toBe(3);
        expect(actual.outputTokens).toBe(2);
      },
    };

    await withRouterScope({ workspaceId: crypto.randomUUID(), zdr: false, budget }, () =>
      chat({ messages: [{ role: 'user', content: 'hi' }], model: 'openrouter:x/y' }));
    expect(calls).toEqual(['check', 'fetch', 'record']);
  });

  it('chat() propagates a denial from check() and never calls fetch or record', async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return okJson({ choices: [{ message: { content: 'hi' } }] });
    }) as unknown as typeof fetch;

    const budget = {
      check: async () => {
        throw new Error('budget exhausted');
      },
      record: async () => {
        throw new Error('record should never be called after a denied check()');
      },
    };

    await expect(
      withRouterScope({ workspaceId: crypto.randomUUID(), zdr: false, budget }, () =>
        chat({ messages: [{ role: 'user', content: 'hi' }], model: 'openrouter:x/y' })),
    ).rejects.toThrow('budget exhausted');
    expect(fetchCalled).toBe(false);
  });

  // A ledger row that check() commits must not be left permanently unresolved if the provider call
  // itself fails after check() passed — see the M8 review finding this closes: an unresolved row's
  // estimated cost would otherwise inflate every later check() in the same run forever, even though
  // nothing was actually spent.
  it('embed() resolves the budget ledger row with $0 when the provider call fails, then rethrows', async () => {
    // A network TypeError is retryable (fetchJson retries up to RETRY_MAX_ATTEMPTS times), so
    // 'fetch' fires more than once here — check()/record() must still each fire exactly once,
    // around the whole retried attempt, not once per underlying fetch.
    let fetchCalls = 0;
    let checkCalls = 0;
    let recordCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new TypeError('network down');
    }) as unknown as typeof fetch;

    const budget = {
      check: async () => {
        checkCalls++;
        return { allowed: true, estimatedCostUsd: 0.001, cumulativeCostUsd: 0.001, budgetUsd: 1 };
      },
      record: async (actual: { inputTokens: number }) => {
        recordCalls++;
        expect(actual.inputTokens).toBe(0); // resolved as unbilled, not the pre-call estimate
      },
    };

    await expect(
      withRouterScope({ workspaceId: crypto.randomUUID(), zdr: false, budget }, () => embed(['hello'])),
    ).rejects.toThrow(RouterError);
    expect(checkCalls).toBe(1);
    expect(recordCalls).toBe(1);
    expect(fetchCalls).toBeGreaterThan(0);
  }, 20_000);

  it('chat() resolves the budget ledger row with $0 when the provider call fails, then rethrows', async () => {
    let fetchCalls = 0;
    let checkCalls = 0;
    let recordCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new TypeError('network down');
    }) as unknown as typeof fetch;

    const budget = {
      check: async () => {
        checkCalls++;
        return { allowed: true, estimatedCostUsd: 0.001, cumulativeCostUsd: 0.001, budgetUsd: 1 };
      },
      record: async (actual: { inputTokens: number }) => {
        recordCalls++;
        expect(actual.inputTokens).toBe(0);
      },
    };

    await expect(
      withRouterScope({ workspaceId: crypto.randomUUID(), zdr: false, budget }, () =>
        chat({ messages: [{ role: 'user', content: 'hi' }], model: 'openrouter:x/y' })),
    ).rejects.toThrow(RouterError);
    expect(checkCalls).toBe(1);
    expect(recordCalls).toBe(1);
    expect(fetchCalls).toBeGreaterThan(0);
  }, 20_000);

  it('a record() failure in the fetch-error path never masks the original provider error', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('network down');
    }) as unknown as typeof fetch;

    const budget = {
      check: async () => ({ allowed: true, estimatedCostUsd: 0.001, cumulativeCostUsd: 0.001, budgetUsd: 1 }),
      record: async () => {
        throw new Error('ledger write also failed');
      },
    };

    const err = await withRouterScope({ workspaceId: crypto.randomUUID(), zdr: false, budget }, () => embed(['hello']))
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RouterError);
    expect((err as RouterError).message).toContain('network error');
  }, 20_000);
});
