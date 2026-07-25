// Live DB test for answerQuestion. Both embed() and chat() are mocked (fake-ai helper) so this
// verifies the plumbing (retrieval -> prompt -> parse) deterministically — it does NOT assert real
// answer quality, which is the manual hand-graded eval's job (`bun run eval:a17`).
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { liveOrFail, hasDbEnv } from './helpers/live.ts';
import { adminSql, closePools } from '../src/db/client.ts';
import { buildContext, resolveGrants } from '../src/core/context.ts';
import { importPage } from '../src/ingest/import.ts';
import { answerQuestion } from '../src/answer/answer.ts';
import { config } from '../src/config.ts';
import { installFakeAiFetch } from './helpers/fake-ai.ts';

// Per-run unique addresses: email_normalized is UNIQUE, and cleanup only runs in afterAll,
// so a crashed run would otherwise poison every future run's setup.
const RUN = crypto.randomUUID().slice(0, 8);

const live = liveOrFail('answer', hasDbEnv());
const mutableConfig = config as unknown as Record<string, unknown>;

describe.skipIf(!live)('answerQuestion — live (chat mocked)', () => {
  let ws = '';
  let p = '';
  const realFetch = globalThis.fetch;
  const realOpenAIKey = mutableConfig.OPENAI_API_KEY;
  const realOpenRouterKey = mutableConfig.OPENROUTER_API_KEY;
  let chatResponse = '{"answer":"stub","citations":[]}';

  beforeAll(async () => {
    mutableConfig.OPENAI_API_KEY = 'test-key';
    mutableConfig.OPENROUTER_API_KEY = 'test-key';
    globalThis.fetch = installFakeAiFetch(() => chatResponse);

    const admin = adminSql();
    p = (await admin<{ id: string }[]>`insert into principals (email, email_normalized) values (${`answer-a-${RUN}@ex.com`}, ${`answer-a-${RUN}@ex.com`}) returning id`)[0]!.id;
    ws = (await admin<{ id: string }[]>`insert into workspaces (name, created_by) values (${'answer-ws'}, ${p}) returning id`)[0]!.id;
    await admin`insert into workspace_members (workspace_id, principal_id, role) values (${ws}, ${p}, 'owner')`;

    const ctx = buildContext({ principal: p, workspaceId: ws, role: 'owner', grants: resolveGrants(p, ws), remote: false });
    await importPage(ctx, { slug: 'answer-doc', title: 'Answer doc', body: 'The office plant is named Fernando.' });
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    mutableConfig.OPENAI_API_KEY = realOpenAIKey;
    mutableConfig.OPENROUTER_API_KEY = realOpenRouterKey;
    const admin = adminSql();
    await admin`delete from workspaces where id = ${ws}`;
    await admin`delete from principals where id = ${p}`;
    await closePools({ timeout: 5 });
  });

  it('valid structured JSON parses into {answer, citations} and sources are populated', async () => {
    chatResponse = '{"answer":"The plant is named Fernando [1].","citations":[1]}';
    const ctx = buildContext({ principal: p, workspaceId: ws, role: 'owner', grants: resolveGrants(p, ws), remote: false });
    const result = await answerQuestion(ctx, 'What is the office plant named?');
    expect(result.answer).toBe('The plant is named Fernando [1].');
    expect(result.citations).toEqual([1]);
    expect(result.sources.length).toBeGreaterThan(0);
  });

  it('invalid JSON degrades gracefully: raw text becomes the answer, citations is empty, no throw', async () => {
    chatResponse = 'this is not json at all, just a plain sentence.';
    const ctx = buildContext({ principal: p, workspaceId: ws, role: 'owner', grants: resolveGrants(p, ws), remote: false });
    const result = await answerQuestion(ctx, 'What is the office plant named?');
    expect(result.answer).toBe(chatResponse);
    expect(result.citations).toEqual([]);
  });

  // ── Citation bounds. Model-generated indices into OUR array. ────────────
  // Before the M1+M2 review the filter was `typeof n === 'number'` and nothing else, so a model (or
  // an injected instruction inside a chunk) could emit [0], [99], [-1] or [1.5] and answerQuestion
  // handed them to the caller as dangling footnotes. Anything doing sources[n-1] then gets undefined.
  const ctxOf = () =>
    buildContext({ principal: p, workspaceId: ws, role: 'owner', grants: resolveGrants(p, ws), remote: false });

  it('drops citations past the end of sources, and below 1', async () => {
    chatResponse = '{"answer":"x [1][99]","citations":[1,99,0,-1]}';
    const r = await answerQuestion(ctxOf(), 'What is the office plant named?');
    expect(r.citations).toEqual([1]);
    expect(r.cited.length).toBe(1);
    for (const n of r.citations) {
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(r.sources.length);
    }
  });

  it('drops non-integers and non-numbers rather than passing them through', async () => {
    chatResponse = '{"answer":"x","citations":[1,1.5,"2",null,true,{"n":3},[]]}';
    const r = await answerQuestion(ctxOf(), 'What is the office plant named?');
    expect(r.citations).toEqual([1]);
  });

  it('collapses duplicates — one source cited twice is one citation', async () => {
    chatResponse = '{"answer":"x [1] and again [1]","citations":[1,1,1]}';
    const r = await answerQuestion(ctxOf(), 'What is the office plant named?');
    expect(r.citations).toEqual([1]);
  });

  it('citations is not an array → empty, no throw', async () => {
    chatResponse = '{"answer":"x","citations":"1,2"}';
    const r = await answerQuestion(ctxOf(), 'What is the office plant named?');
    expect(r.citations).toEqual([]);
    expect(r.cited).toEqual([]);
    expect(r.answer).toBe('x');
  });

  it('valid JSON whose answer is NOT a string degrades — and drops its citations with it', async () => {
    chatResponse = '{"answer":42,"citations":[1]}';
    const r = await answerQuestion(ctxOf(), 'What is the office plant named?');
    expect(r.answer).toBe(chatResponse);
    expect(r.citations).toEqual([]); // never keep citations from a payload we rejected
  });

  it('`cited` resolves the 1-based indices so no caller has to know the offset', async () => {
    chatResponse = '{"answer":"The plant is named Fernando [1].","citations":[1]}';
    const r = await answerQuestion(ctxOf(), 'What is the office plant named?');
    expect(r.cited).toHaveLength(r.citations.length);
    // THE contract, asserted directly rather than trusted: cited[i] === sources[citations[i] - 1].
    r.citations.forEach((n, i) => expect(r.cited[i]).toBe(r.sources[n - 1]!));
    expect(r.cited[0]!.slug).toBeTruthy();
  });

  it('every returned citation indexes a real source — no dangling footnote, ever', async () => {
    for (const payload of [
      '{"answer":"a","citations":[1,2,3,4,5,6,7,8,9,10,11,12]}',
      '{"answer":"b","citations":[1000000]}',
      '{"answer":"c","citations":[]}',
    ]) {
      chatResponse = payload;
      const r = await answerQuestion(ctxOf(), 'What is the office plant named?');
      expect(r.citations.every((n) => n >= 1 && n <= r.sources.length)).toBe(true);
      expect(r.cited.every((c) => c !== undefined)).toBe(true);
    }
  });

  it('an out-of-range inline marker is removed from the answer text', async () => {
    // The clamp guards `citations`; this guards what the human reads. An adversarial pass caught the
    // gap: `"x [1][99]"` shipped a live [99] while the array was correctly cleaned to [1].
    chatResponse = '{"answer":"Revenue grew [1] and headcount doubled [99].","citations":[1,99]}';
    const r = await answerQuestion(ctxOf(), 'What is the office plant named?');
    expect(r.citations).toEqual([1]);
    expect(r.answer).toContain('[1]');
    expect(r.answer).not.toContain('[99]'); // no footnote to nothing
  });

  it('in-range markers are left alone — whether the model cited the RIGHT chunk is not parseable', async () => {
    chatResponse = '{"answer":"a [1] b [1]","citations":[1]}';
    const r = await answerQuestion(ctxOf(), 'What is the office plant named?');
    expect(r.answer).toBe('a [1] b [1]');
  });

  it('recovers from a markdown code fence instead of degrading the whole completion', async () => {
    // The single most common structured-output deviation, and a cheap way for an injected chunk to
    // blank the citation trail AND widen the output channel (the degrade path returns everything).
    chatResponse = '```json\n{"answer":"Fernando [1].","citations":[1]}\n```';
    const r = await answerQuestion(ctxOf(), 'What is the office plant named?');
    expect(r.answer).toBe('Fernando [1].');
    expect(r.citations).toEqual([1]);
    expect(r.cited).toHaveLength(1);
  });
});
