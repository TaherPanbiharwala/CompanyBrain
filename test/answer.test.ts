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
});
