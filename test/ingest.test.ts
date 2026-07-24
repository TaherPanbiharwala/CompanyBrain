// Live DB test for the ingest waist. Mirrors rls-smoke.test.ts's seed/teardown pattern; embed() is
// mocked (fake-ai helper) so this exercises real Postgres/RLS without real API cost — answer
// QUALITY is validated separately by `bun run eval:a17`, never by this structural test.
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { adminSql, closePools, withScopedTx } from '../src/db/client.ts';
import { buildContext, resolveGrants } from '../src/core/context.ts';
import { importPage } from '../src/ingest/import.ts';
import { config } from '../src/config.ts';
import { installFakeAiFetch } from './helpers/fake-ai.ts';

const live = !!process.env.DATABASE_URL && !!process.env.DATABASE_ADMIN_URL;
const mutableConfig = config as unknown as Record<string, unknown>;

describe.skipIf(!live)('importPage — live', () => {
  let ws1 = '';
  let ws2 = '';
  let p1 = '';
  let p2 = '';
  const realFetch = globalThis.fetch;
  const realKey = mutableConfig.OPENAI_API_KEY;

  beforeAll(async () => {
    mutableConfig.OPENAI_API_KEY = 'test-key';
    globalThis.fetch = installFakeAiFetch();

    const admin = adminSql();
    p1 = (await admin<{ id: string }[]>`insert into principals (email, email_normalized) values (${'ingest-a@ex.com'}, ${'ingest-a@ex.com'}) returning id`)[0]!.id;
    p2 = (await admin<{ id: string }[]>`insert into principals (email, email_normalized) values (${'ingest-b@ex.com'}, ${'ingest-b@ex.com'}) returning id`)[0]!.id;
    ws1 = (await admin<{ id: string }[]>`insert into workspaces (name, created_by) values (${'ingest-ws1'}, ${p1}) returning id`)[0]!.id;
    ws2 = (await admin<{ id: string }[]>`insert into workspaces (name, created_by) values (${'ingest-ws2'}, ${p2}) returning id`)[0]!.id;
    await admin`insert into workspace_members (workspace_id, principal_id, role) values (${ws1}, ${p1}, 'owner'), (${ws2}, ${p2}, 'owner')`;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    mutableConfig.OPENAI_API_KEY = realKey;
    const admin = adminSql();
    await admin`delete from workspaces where id in (${ws1}, ${ws2})`;
    await admin`delete from principals where id in (${p1}, ${p2})`;
    await closePools({ timeout: 5 });
  });

  it('writes the page + chunks with the correct workspace_id, and embeddings are stored', async () => {
    const ctx = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });
    const result = await importPage(ctx, { slug: 'doc-a', title: 'Doc A', body: 'A short body about widgets and gadgets.' });
    expect(result.chunkCount).toBe(1);
    expect(result.pageId).toBeTruthy();

    const admin = adminSql();
    const pageRows = await admin<{ workspace_id: string; slug: string }[]>`select workspace_id, slug from pages where id = ${result.pageId}`;
    expect(pageRows).toHaveLength(1);
    expect(pageRows[0]!.workspace_id).toBe(ws1);
    expect(pageRows[0]!.slug).toBe('doc-a');

    const chunkRows = await admin<{ workspace_id: string; has_embedding: boolean }[]>`select workspace_id, embedding is not null as has_embedding from content_chunks where page_id = ${result.pageId}`;
    expect(chunkRows).toHaveLength(1);
    expect(chunkRows[0]!.workspace_id).toBe(ws1);
    expect(chunkRows[0]!.has_embedding).toBeTruthy();
  });

  it('an empty body ingests the page with zero chunks (no throw, no embed call)', async () => {
    const ctx = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });
    const result = await importPage(ctx, { slug: 'doc-empty', title: 'Empty', body: '' });
    expect(result.chunkCount).toBe(0);
    expect(result.pageId).toBeTruthy();
  });

  it('a second workspace cannot see the first workspace\'s ingested page (RLS)', async () => {
    const ctx1 = buildContext({ principal: p1, workspaceId: ws1, role: 'owner', grants: resolveGrants(p1, ws1), remote: false });
    await importPage(ctx1, { slug: 'doc-b', title: 'Doc B', body: 'content only ws1 should ever see' });

    // withScopedTx as ws2's ctx, explicitly filtered to ws1's id — RLS must still hide it since
    // app.workspace is set to ws2, regardless of what the WHERE clause asks for.
    const ctx2 = buildContext({ principal: p2, workspaceId: ws2, role: 'owner', grants: resolveGrants(p2, ws2), remote: false });
    const rows = await withScopedTx(ctx2, (tx) => tx`select id from pages where workspace_id = ${ws1} and slug = ${'doc-b'}`);
    expect(rows.length).toBe(0);
  });
});
