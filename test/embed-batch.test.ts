// Batching, reranking and the degrade seams.
//
// No database. The provider is a stub, so what is under test is OUR arithmetic — which is where the
// dangerous bugs are. An embedding mixed up between two chunks does not throw, does not look wrong
// in the database, and shows up months later as "search returns the wrong paragraph".
import { describe, it, expect, afterEach } from 'bun:test';
import { planBatches, embedAll, MAX_BATCH_ITEMS, MAX_BATCH_TOKENS, MAX_INPUT_TOKENS } from '../src/ingest/embed.ts';
import { rerank, isRerankEnabled, expandQuery, isExpansionEnabled, withRouterScope, RouterError } from '../src/ai/router.ts';
import { estimateTokens } from '../src/ingest/chunk.ts';
import { config } from '../src/config.ts';

const mutableConfig = config as unknown as Record<string, unknown>;
const realFetch = globalThis.fetch;
const realOpenAI = mutableConfig.OPENAI_API_KEY;
const realRerank = mutableConfig.RERANK_MODEL;
const realExpansion = mutableConfig.QUERY_EXPANSION;
const realChat = mutableConfig.CHAT_MODEL;

afterEach(() => {
  globalThis.fetch = realFetch;
  mutableConfig.OPENAI_API_KEY = realOpenAI;
  mutableConfig.RERANK_MODEL = realRerank;
  mutableConfig.QUERY_EXPANSION = realExpansion;
  mutableConfig.CHAT_MODEL = realChat;
});

const scoped = <T>(fn: () => Promise<T>): Promise<T> => withRouterScope({ workspaceId: 'ws-test', zdr: false }, fn);

describe('planBatches', () => {
  it('covers every input exactly once, in order, with no gaps', () => {
    // The property that matters more than any specific split: batches are a PARTITION of the input.
    // A gap silently drops a chunk; an overlap embeds one twice and pays for it twice.
    const texts = Array.from({ length: 250 }, (_, i) => `chunk ${i} ${'word '.repeat(20)}`);
    const batches = planBatches(texts);
    expect(batches[0]!.start).toBe(0);
    expect(batches.at(-1)!.end).toBe(texts.length);
    for (let i = 1; i < batches.length; i++) {
      expect(batches[i]!.start, `gap or overlap before batch ${i}`).toBe(batches[i - 1]!.end);
    }
  });

  it('caps items per batch', () => {
    const texts = Array.from({ length: 200 }, () => 'tiny');
    for (const b of planBatches(texts)) expect(b.end - b.start).toBeLessThanOrEqual(MAX_BATCH_ITEMS);
  });

  it('caps tokens per batch, which binds before the item cap on real prose', () => {
    // ~1200 tokens each: 64 of them would be ~77k tokens, far past a batch that can return inside
    // EMBED_TIMEOUT_MS. The token bound is the one that actually protects the request.
    const big = 'x'.repeat(4800);
    const batches = planBatches(Array.from({ length: 40 }, () => big));
    for (const b of batches) {
      const tokens = (b.end - b.start) * estimateTokens(big);
      expect(tokens).toBeLessThanOrEqual(MAX_BATCH_TOKENS + estimateTokens(big));
    }
    expect(batches.length, 'the token cap never split anything — the fixture is too small').toBeGreaterThan(1);
  });

  it('gives an oversized item its own batch WITHOUT reordering its neighbours', () => {
    const texts = ['a', 'b', 'x'.repeat(MAX_BATCH_TOKENS * 4), 'c'];
    const batches = planBatches(texts);
    // Whatever the split, order is preserved and the partition is complete — the oversized item must
    // not be hoisted out and appended, which would silently permute the results.
    expect(batches[0]!.start).toBe(0);
    expect(batches.at(-1)!.end).toBe(4);
    for (let i = 1; i < batches.length; i++) expect(batches[i]!.start).toBe(batches[i - 1]!.end);
  });

  it('handles the empty and single cases', () => {
    expect(planBatches([])).toEqual([]);
    expect(planBatches(['one'])).toEqual([{ start: 0, end: 1 }]);
  });
});

describe('embedAll', () => {
  /** A stub embedder that returns a vector encoding the INPUT TEXT, so a mis-ordered result is
   *  detectable rather than merely suspected. `shuffle` returns items out of input order with
   *  correct `index` fields — which is what the real provider is allowed to do. */
  function stubEmbedder(opts: { shuffle?: boolean; dropIndex?: number } = {}) {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes('/embeddings')) throw new Error(`unexpected url ${url}`);
      const body = JSON.parse(String((init as { body?: string }).body)) as { input: string[] };
      let data = body.input.map((t, i) => ({
        index: i,
        // The first element carries the text's identity; the rest is padding to EMBEDDING_DIM.
        embedding: [Number(t.match(/\d+/)?.[0] ?? -1), ...Array(config.EMBEDDING_DIM - 1).fill(0)],
      }));
      if (opts.dropIndex !== undefined && data.length > 1) {
        // Simulate a provider duplicating an index: the COUNT stays right, so the router's own check
        // passes, and one input silently goes un-embedded.
        data = data.map((d, i) => (i === opts.dropIndex ? { ...d, index: data[0]!.index } : d));
      }
      if (opts.shuffle) data = [...data].reverse();
      return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  }

  it('returns vectors in INPUT order across many batches, even when the provider shuffles', async () => {
    mutableConfig.OPENAI_API_KEY = 'test-key';
    globalThis.fetch = stubEmbedder({ shuffle: true });
    const texts = Array.from({ length: 150 }, (_, i) => `chunk ${i}`);
    const vectors = await scoped(() => embedAll(texts));
    expect(vectors).toHaveLength(150);
    // Every position holds ITS OWN text's marker. This is the assertion that catches the whole class
    // of bug: concatenating batch results by completion order, sorting the concatenation, or pushing
    // instead of assigning by absolute offset all fail here and nowhere else.
    for (let i = 0; i < texts.length; i++) expect(vectors[i]![0], `chunk ${i} got another chunk's vector`).toBe(i);
  });

  it('throws rather than returning a hole when a provider duplicates an index', async () => {
    mutableConfig.OPENAI_API_KEY = 'test-key';
    globalThis.fetch = stubEmbedder({ dropIndex: 1 });
    const err = await scoped(() => embedAll(['chunk 0', 'chunk 1', 'chunk 2'])).then(
      () => null,
      (e: Error) => e,
    );
    // Silence here would store one chunk with a duplicate vector and leave another unembedded —
    // and the router's count check cannot see it, because the count is correct.
    expect(err?.message ?? '').toMatch(/no embedding for input|no vector for chunk/);
  });

  it('refuses an over-large input before spending anything', async () => {
    mutableConfig.OPENAI_API_KEY = 'test-key';
    let called = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      called++;
      return stubEmbedder()(...args);
    }) as typeof fetch;
    const huge = 'x'.repeat(MAX_INPUT_TOKENS * 4 + 5_000);
    const err = await scoped(() => embedAll(['fine', huge])).then(() => null, (e: Error) => e);
    expect(err?.message ?? '').toMatch(/over the .* per-input limit/);
    expect(called, 'the guard fired only AFTER paying the provider').toBe(0);
  });

  it('is a no-op for no input', async () => {
    expect(await embedAll([])).toEqual([]);
  });
});

describe('rerank seam', () => {
  it('is off by default, and says so without throwing', () => {
    mutableConfig.RERANK_MODEL = '';
    expect(isRerankEnabled()).toBe(false);
  });

  it('throws when called while unconfigured, rather than silently no-opping', async () => {
    // "Off" and "misconfigured" must stay distinguishable. If this returned [] instead, a typo in
    // RERANK_MODEL would look exactly like the default and the operator would never learn.
    mutableConfig.RERANK_MODEL = '';
    const err = await scoped(() => rerank('q', [{ id: 'a', text: 'x' }])).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(RouterError);
    expect(err!.message).toMatch(/no RERANK_MODEL configured/);
  });

  it('maps provider indices back to ids, never positionally', async () => {
    // Rerank responses come back SORTED BY SCORE, so reading them positionally maps every score to
    // the wrong document — the same trap as embed(), with an ordering that makes it look plausible.
    mutableConfig.RERANK_MODEL = 'cohere:rerank-v3.5';
    process.env.COHERE_API_KEY = 'test-key';
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ results: [{ index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.5 }, { index: 1, relevance_score: 0.1 }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;

    const out = await scoped(() =>
      rerank('q', [{ id: 'first', text: 'a' }, { id: 'second', text: 'b' }, { id: 'third', text: 'c' }]),
    );
    expect(out.map((r) => r.id)).toEqual(['third', 'first', 'second']);
    delete process.env.COHERE_API_KEY;
  });

  it('drops an out-of-range index instead of trusting it', async () => {
    mutableConfig.RERANK_MODEL = 'cohere:rerank-v3.5';
    process.env.COHERE_API_KEY = 'test-key';
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ results: [{ index: 99, relevance_score: 0.9 }, { index: 0, relevance_score: 0.4 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    // `items[99]` is undefined; taking `.id` off it yields a chunk id of `undefined`, which then
    // fails to match anything in the caller's map and silently drops a real result.
    const out = await scoped(() => rerank('q', [{ id: 'only', text: 'a' }]));
    expect(out).toEqual([{ id: 'only', score: 0.4 }]);
    delete process.env.COHERE_API_KEY;
  });
});

describe('query expansion seam', () => {
  it('is off by default and makes no call', async () => {
    mutableConfig.QUERY_EXPANSION = 0;
    let called = 0;
    globalThis.fetch = (async () => {
      called++;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    expect(isExpansionEnabled()).toBe(false);
    expect(await scoped(() => expandQuery('anything'))).toEqual([]);
    expect(called).toBe(0);
  });

  it('returns paraphrases when enabled', async () => {
    mutableConfig.QUERY_EXPANSION = 1;
    mutableConfig.CHAT_MODEL = 'openrouter:test/model';
    mutableConfig.OPENROUTER_API_KEY = 'test-key';
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: '["renewal discount","contract price cut"]' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;
    expect(await scoped(() => expandQuery('what discount was agreed'))).toEqual(['renewal discount', 'contract price cut']);
  });

  it('swallows a paraphrase failure rather than failing the question', async () => {
    // An enhancement on the ask path must never be able to sink the ask. The unexpanded query is a
    // perfectly good query.
    mutableConfig.QUERY_EXPANSION = 1;
    mutableConfig.CHAT_MODEL = 'openrouter:test/model';
    mutableConfig.OPENROUTER_API_KEY = 'test-key';
    globalThis.fetch = (async () => new Response('upstream exploded', { status: 500 })) as unknown as typeof fetch;
    expect(await scoped(() => expandQuery('a question'))).toEqual([]);
  });

  it('ignores a non-array response', async () => {
    mutableConfig.QUERY_EXPANSION = 1;
    mutableConfig.CHAT_MODEL = 'openrouter:test/model';
    mutableConfig.OPENROUTER_API_KEY = 'test-key';
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'sorry, I cannot do that' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    expect(await scoped(() => expandQuery('a question'))).toEqual([]);
  });
});
