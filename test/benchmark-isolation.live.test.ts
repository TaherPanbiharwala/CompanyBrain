// Small live fixtures for the two M10 benchmark boundaries. They exercise real RLS and the normal
// import/search/cycle paths with fake providers, so no benchmark corpus or paid request is needed.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { liveOrFail, hasDbEnv } from './helpers/live.ts';
import { installFakeAiFetch } from './helpers/fake-ai.ts';
import { adminSql, closePools, withScopedTx } from '../src/db/client.ts';
import { buildContext, resolveGrants, type OperationContext } from '../src/core/context.ts';
import { config } from '../src/config.ts';
import { importPage } from '../src/ingest/import.ts';
import { hybridSearch } from '../src/search/hybrid.ts';
import { runCycle } from '../src/core/cycle.ts';

const RUN = crypto.randomUUID().slice(0, 8);
const live = liveOrFail('benchmark-isolation', hasDbEnv());
const mutableConfig = config as unknown as Record<string, unknown>;

describe.skipIf(!live)('M10 benchmark fixtures — live RLS boundaries', () => {
  let longMemOwner = '';
  let otherCaseOwner = '';
  let amaraOwner = '';
  let longMemWorkspace = '';
  let otherCaseWorkspace = '';
  let amaraWorkspace = '';
  let longMemCtx: OperationContext;
  let otherCaseCtx: OperationContext;
  let amaraCtx: OperationContext;
  const realFetch = globalThis.fetch;
  const realOpenAiKey = mutableConfig.OPENAI_API_KEY;
  const realOpenRouterKey = mutableConfig.OPENROUTER_API_KEY;
  const realChatModel = mutableConfig.CHAT_MODEL;

  beforeAll(async () => {
    mutableConfig.OPENAI_API_KEY = 'test-key';
    mutableConfig.OPENROUTER_API_KEY = 'test-key';
    mutableConfig.CHAT_MODEL = 'openrouter:deepseek/deepseek-v4-flash';
    globalThis.fetch = installFakeAiFetch(() => JSON.stringify({ facts: [
      { entity: 'Amara', kind: 'fact', notability: 'medium', confidence: 0.9, claim_text: 'Amara approved the benchmark fixture.', source_excerpt: 'Amara approved the benchmark fixture.' },
    ] }));

    const admin = adminSql();
    const principal = async (tag: string) => (await admin<{ id: string }[]>`
      insert into principals (email, email_normalized) values (${`m10-${tag}-${RUN}@example.com`}, ${`m10-${tag}-${RUN}@example.com`}) returning id`)[0]!.id;
    longMemOwner = await principal('longmem');
    otherCaseOwner = await principal('other-case');
    amaraOwner = await principal('amara');
    const workspace = async (tag: string, owner: string) => (await admin<{ id: string }[]>`
      insert into workspaces (name, created_by) values (${`m10-${tag}-${RUN}`}, ${owner}) returning id`)[0]!.id;
    longMemWorkspace = await workspace('longmem', longMemOwner);
    otherCaseWorkspace = await workspace('other-case', otherCaseOwner);
    amaraWorkspace = await workspace('amara', amaraOwner);
    await admin`insert into workspace_members (workspace_id, principal_id, role) values
      (${longMemWorkspace}, ${longMemOwner}, 'owner'),
      (${otherCaseWorkspace}, ${otherCaseOwner}, 'owner'),
      (${amaraWorkspace}, ${amaraOwner}, 'owner')`;
    const context = (principal: string, workspaceId: string) => buildContext({ principal, workspaceId, role: 'owner', grants: resolveGrants(principal, workspaceId), remote: false });
    longMemCtx = context(longMemOwner, longMemWorkspace);
    otherCaseCtx = context(otherCaseOwner, otherCaseWorkspace);
    amaraCtx = context(amaraOwner, amaraWorkspace);
  }, 120_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    mutableConfig.OPENAI_API_KEY = realOpenAiKey;
    mutableConfig.OPENROUTER_API_KEY = realOpenRouterKey;
    mutableConfig.CHAT_MODEL = realChatModel;
    const admin = adminSql();
    await admin`delete from workspaces where id in (${longMemWorkspace}, ${otherCaseWorkspace}, ${amaraWorkspace})`;
    await admin`delete from principals where id in (${longMemOwner}, ${otherCaseOwner}, ${amaraOwner})`;
    await closePools({ timeout: 5 });
  }, 60_000);

  it('one LongMemEval case cannot retrieve another case session', async () => {
    await importPage(longMemCtx, { slug: `lme-case-a-${RUN}`, title: 'case a', body: 'case A only says amber' });
    await importPage(otherCaseCtx, { slug: `lme-case-b-${RUN}`, title: 'case b', body: 'other case sentinel zirconium only' });
    const outcome = await hybridSearch(longMemCtx, 'zirconium only', { topK: 5 });
    expect(outcome.hits.map((hit) => hit.slug)).not.toContain(`lme-case-b-${RUN}`);
    const physicalProbe = await withScopedTx(longMemCtx, (tx) => tx`
      select id from pages where workspace_id = ${otherCaseWorkspace} and slug = ${`lme-case-b-${RUN}`}`);
    expect(physicalProbe).toHaveLength(0);
  }, 120_000);

  it('Amara facts stay RLS-isolated after the M10A fact phase', async () => {
    const page = await importPage(amaraCtx, { slug: `amara-fixture-${RUN}`, title: 'Amara fixture', body: 'Amara approved the benchmark fixture.' });
    const report = await runCycle({ workspaceId: amaraWorkspace, phases: ['fact_extraction'] });
    expect(report.status).toBe('ok');
    const ownerFacts = await withScopedTx(amaraCtx, (tx) => tx<{ id: string }[]>`select id from facts where source_page_id = ${page.pageId}`);
    expect(ownerFacts).toHaveLength(1);
    const outsideFacts = await withScopedTx(longMemCtx, (tx) => tx<{ id: string }[]>`select id from facts where source_page_id = ${page.pageId}`);
    expect(outsideFacts).toHaveLength(0);
  }, 120_000);
});
