// The file-ingest path has its own page/chunk transaction, so the paste-ingest backlink test does
// not prove this hook is wired. Exercise real extracted_text -> link reconciliation end to end.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { liveOrFail, hasDbEnv } from './helpers/live.ts';
import { installFakeAiFetch } from './helpers/fake-ai.ts';
import { adminSql, closePools, withScopedTx } from '../src/db/client.ts';
import { buildContext, resolveGrants, type OperationContext } from '../src/core/context.ts';
import { importPage } from '../src/ingest/import.ts';
import { importFile } from '../src/ingest/file.ts';
import { config } from '../src/config.ts';

const live = liveOrFail('links-file', hasDbEnv());
const RUN = crypto.randomUUID().slice(0, 8);
const mutableConfig = config as unknown as Record<string, unknown>;

describe.skipIf(!live)('importFile link hook — live', () => {
  let principalId = '';
  let workspaceId = '';
  const realFetch = globalThis.fetch;
  const realKey = mutableConfig.OPENAI_API_KEY;

  const ctx = (): OperationContext => buildContext({
    principal: principalId,
    workspaceId,
    role: 'owner',
    grants: resolveGrants(principalId, workspaceId),
    remote: false,
  });

  beforeAll(async () => {
    mutableConfig.OPENAI_API_KEY = 'test-key';
    globalThis.fetch = installFakeAiFetch();
    const admin = adminSql();
    const email = `links-file-${RUN}@ex.com`;
    principalId = (await admin<{ id: string }[]>`
      insert into principals (email, email_normalized) values (${email}, ${email}) returning id`)[0]!.id;
    workspaceId = (await admin<{ id: string }[]>`
      insert into workspaces (name, created_by) values (${`links-file-${RUN}`}, ${principalId}) returning id`)[0]!.id;
    await admin`
      insert into workspace_members (workspace_id, principal_id, role)
      values (${workspaceId}, ${principalId}, 'owner')`;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    mutableConfig.OPENAI_API_KEY = realKey;
    const admin = adminSql();
    await admin`delete from workspaces where id = ${workspaceId}`;
    await admin`delete from principals where id = ${principalId}`;
    await closePools({ timeout: 5 });
  });

  it('creates a backlink from extracted file text in the same ingest transaction', async () => {
    const target = await importPage(ctx(), {
      slug: `file-target-${RUN}`,
      title: `File Target ${RUN}`,
      body: 'The target page.',
    });
    const sourceText = [
      'This is a sufficiently long uploaded text document for extraction.',
      `It explicitly references File Target ${RUN} for the supporting details.`,
    ].join('\n');
    const source = await importFile(ctx(), {
      bytes: new Uint8Array(Buffer.from(sourceText, 'utf8')),
      filename: `source-${RUN}.txt`,
      slug: `file-source-${RUN}`,
    });

    const rows = await withScopedTx(ctx(), (tx) => tx<{ to_page_id: string; link_kind: string }[]>`
      select to_page_id, link_kind from links where from_page_id = ${source.pageId}`);
    expect([...rows]).toEqual([{ to_page_id: target.pageId, link_kind: 'mention' }]);
  }, 120_000);
});
