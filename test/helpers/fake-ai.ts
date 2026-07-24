// Shared test-only AI mocking, following router.test.ts's fetch-mocking convention. Used by
// ingest/hybrid/answer live tests so they exercise real Postgres/RLS without real API cost or
// flakiness — embedding/answer QUALITY is validated separately by `bun run eval:a17` against the
// real provider, never by these structural tests.
export function fakeEmbedVector(text: string, dim = 1536): number[] {
  // Deterministic pseudo-embedding: identical strings -> identical vectors (cosine distance 0,
  // useful for exact-match search tests); different strings -> effectively uncorrelated vectors.
  let seed = 0;
  for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
  const vec = new Array<number>(dim);
  for (let i = 0; i < dim; i++) {
    const x = Math.sin(seed + i) * 10000;
    vec[i] = (x - Math.floor(x)) * 2 - 1;
  }
  return vec;
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/** Routes on URL: /embeddings -> OpenAI-shaped response using fakeEmbedVector per input text;
 *  /chat/completions -> OpenRouter-shaped response with the given (or default) content. */
export function installFakeAiFetch(chatContent: () => string = () => '{"answer":"stub","citations":[]}') {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.includes('/embeddings')) {
      const body: { input: string | string[] } = JSON.parse(String(init?.body ?? '{}'));
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return new Response(
        JSON.stringify({ data: inputs.map((t, i) => ({ index: i, embedding: fakeEmbedVector(t) })) }),
        { status: 200 },
      );
    }
    if (url.includes('/chat/completions')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: chatContent() } }] }), { status: 200 });
    }
    throw new Error(`fakeAiFetch: unexpected URL ${url}`);
  }) as unknown as typeof fetch;
}
