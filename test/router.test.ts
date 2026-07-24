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
});
