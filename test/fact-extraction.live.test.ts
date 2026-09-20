// End-to-end coverage for FactExtractionPhase (M10 wave 1 sub-step A), run through the real cycle
// engine against fake AI responses — no real LLM cost, real RLS/Postgres. Mirrors
// test/links-security.live.test.ts's fake-AI convention (installFakeAiFetch).
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { liveOrFail, hasDbEnv } from './helpers/live.ts';
import { installFakeAiFetch } from './helpers/fake-ai.ts';
import { adminSql, closePools, withScopedTx } from '../src/db/client.ts';
import { buildContext, resolveGrants, type OperationContext } from '../src/core/context.ts';
import { importPage } from '../src/ingest/import.ts';
import { runCycle } from '../src/core/cycle.ts';
import { config } from '../src/config.ts';

const RUN = crypto.randomUUID().slice(0, 8);
const live = liveOrFail('fact-extraction', hasDbEnv());
const mutableConfig = config as unknown as Record<string, unknown>;

describe.skipIf(!live)('fact_extraction cycle phase — live', () => {
  let workspaceId = '';
  let ownerId = '';
  let ownerCtx: OperationContext;
  const realFetch = globalThis.fetch;
  const realOpenAiKey = mutableConfig.OPENAI_API_KEY;
  const realOpenRouterKey = mutableConfig.OPENROUTER_API_KEY;
  const realChatModel = mutableConfig.CHAT_MODEL;

  const factsFor = (pageId: string) =>
    withScopedTx(ownerCtx, (tx) => tx<{
      id: string; claim_text: string; entity_slug: string | null;
      consolidated_into: string | null; consolidated_at: Date | null;
    }[]>`select id, claim_text, entity_slug, consolidated_into, consolidated_at from facts where source_page_id = ${pageId}`);

  const factsJson = (facts: unknown[]) => JSON.stringify({ facts });

  beforeAll(async () => {
    mutableConfig.OPENAI_API_KEY = 'test-key';
    mutableConfig.OPENROUTER_API_KEY = 'test-key';
    mutableConfig.CHAT_MODEL = 'openrouter:deepseek/deepseek-v4-flash';

    const admin = adminSql();
    ownerId = (await admin<{ id: string }[]>`
      insert into principals (email, email_normalized)
      values (${`fact-extraction-${RUN}@example.com`}, ${`fact-extraction-${RUN}@example.com`})
      returning id`)[0]!.id;
    workspaceId = (await admin<{ id: string }[]>`
      insert into workspaces (name, created_by) values (${`fact-extraction-${RUN}`}, ${ownerId}) returning id`)[0]!.id;
    await admin`insert into workspace_members (workspace_id, principal_id, role) values (${workspaceId}, ${ownerId}, 'owner')`;
    ownerCtx = buildContext({
      principal: ownerId, workspaceId, role: 'owner', grants: resolveGrants(ownerId, workspaceId), remote: false,
    });
  }, 120_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    mutableConfig.OPENAI_API_KEY = realOpenAiKey;
    mutableConfig.OPENROUTER_API_KEY = realOpenRouterKey;
    mutableConfig.CHAT_MODEL = realChatModel;
    const admin = adminSql();
    await admin`delete from workspaces where id = ${workspaceId}`;
    await admin`delete from principals where id = ${ownerId}`;
    await closePools({ timeout: 5 });
  }, 60_000);

  it('extracts, embeds, writes a fact, and stamps the page so a re-run skips it', async () => {
    globalThis.fetch = installFakeAiFetch(() => factsJson([
      { entity: 'Acme Corp', kind: 'fact', notability: 'high', confidence: 0.9,
        claim_text: 'Acme Corp raised a Series A.', source_excerpt: 'Acme Corp closed its Series A.' },
    ]));

    const page = await importPage(ownerCtx, {
      slug: `fact-e2e-${RUN}`, title: `Fact E2E ${RUN}`, body: 'Acme Corp closed its Series A round this week.',
    });

    const report = await runCycle({ workspaceId, phases: ['fact_extraction'] });
    expect(report.status).toBe('ok');
    const phase = report.phases.find((p) => p.phase === 'fact_extraction');
    expect(phase?.status).toBe('ok');
    expect(phase?.details.facts_written).toBe(1);

    const facts = await factsFor(page.pageId);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ claim_text: 'Acme Corp raised a Series A.', entity_slug: 'acme-corp' });

    const [stamped] = await adminSql()<{ facts_extracted_content_hash: string | null; content_hash: string | null }[]>`
      select facts_extracted_content_hash, content_hash from pages where id = ${page.pageId}`;
    expect(stamped?.facts_extracted_content_hash).not.toBeNull();
    expect(stamped?.facts_extracted_content_hash).toBe(stamped?.content_hash);

    // Re-run: the candidate function should now skip this page entirely — assert via the dry-run
    // report rather than a call counter, since it exercises the exact server-side filter that matters.
    const dryRun = await runCycle({ workspaceId, phases: ['fact_extraction'], dryRun: true });
    const dryPhase = dryRun.phases.find((p) => p.phase === 'fact_extraction');
    expect(dryPhase?.details.pages_total).toBe(0);
  }, 120_000);

  it('two pages producing near-identical claims for the same entity deduplicate on the second', async () => {
    const claim = 'Beta Inc raised a seed round.';
    globalThis.fetch = installFakeAiFetch(() => factsJson([
      { entity: 'Beta Inc', kind: 'fact', notability: 'medium', confidence: 0.8, claim_text: claim, source_excerpt: claim },
    ]));

    const pageA = await importPage(ownerCtx, { slug: `fact-dedup-a-${RUN}`, title: `Dedup A ${RUN}`, body: claim });
    await runCycle({ workspaceId, phases: ['fact_extraction'] });
    const factsA = await factsFor(pageA.pageId);
    expect(factsA).toHaveLength(1);
    expect(factsA[0]!.consolidated_into).toBeNull();

    const pageB = await importPage(ownerCtx, { slug: `fact-dedup-b-${RUN}`, title: `Dedup B ${RUN}`, body: claim + ' (restated)' });
    await runCycle({ workspaceId, phases: ['fact_extraction'] });
    const factsB = await factsFor(pageB.pageId);
    expect(factsB).toHaveLength(1);
    // Identical claim_text -> identical fakeEmbedVector -> cosine similarity 1.0, well over the 0.95
    // threshold. installFakeAiFetch's deterministic embedding is exactly what makes this assertion
    // possible without a real embedding provider.
    expect(factsB[0]!.consolidated_into).toBe(factsA[0]!.id);
    expect(factsB[0]!.consolidated_at).not.toBeNull();
  }, 120_000);

  it('a malformed LLM response records a failure, writes no facts, and leaves the page unstamped', async () => {
    globalThis.fetch = installFakeAiFetch(() => 'this is not JSON at all');
    const page = await importPage(ownerCtx, {
      slug: `fact-malformed-${RUN}`, title: `Fact Malformed ${RUN}`, body: 'some content to extract from',
    });

    const report = await runCycle({ workspaceId, phases: ['fact_extraction'] });
    const phase = report.phases.find((p) => p.phase === 'fact_extraction');
    expect(phase?.status).toBe('warn');
    expect(phase?.details.failures).toBe(1);
    expect(await factsFor(page.pageId)).toHaveLength(0);

    const [stamped] = await adminSql()<{ facts_extracted_content_hash: string | null }[]>`
      select facts_extracted_content_hash from pages where id = ${page.pageId}`;
    expect(stamped?.facts_extracted_content_hash).toBeNull();

    const [failure] = await adminSql()<{ item_key: string; error_code: string }[]>`
      select item_key, error_code from cycle_failures where workspace_id = ${workspaceId} and op = 'fact_extraction' and item_key = ${page.pageId}`;
    expect(failure).toBeDefined();
  }, 120_000);

  it('an immediately-exhausted budget fails the whole phase rather than silently skipping the page', async () => {
    globalThis.fetch = installFakeAiFetch(() => factsJson([{ claim_text: 'irrelevant' }]));
    const page = await importPage(ownerCtx, {
      slug: `fact-budget-${RUN}`, title: `Fact Budget ${RUN}`, body: 'x'.repeat(200),
    });

    // A cap smaller than even a zero-token estimate's rounding floor is not guaranteed to deny on
    // ESTIMATE alone — the pricing model can legitimately estimate $0 for a tiny call. What matters is
    // that SOME cap denies the run and the failure is reported honestly, not that this exact value does.
    const report = await runCycle({ workspaceId, phases: ['fact_extraction'], budgetUsdOverride: 0.00000001 });
    const phase = report.phases.find((p) => p.phase === 'fact_extraction');
    expect(phase?.status).toBe('fail');
    expect(phase?.error?.code).toBe('BUDGET_EXHAUSTED');
    expect(await factsFor(page.pageId)).toHaveLength(0);
  }, 120_000);
});
