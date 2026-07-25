// scope → acl. The mapping that decides who can read a page.
//
// This exists because the M1+M2 review found `scope` was a decorative knob: the op advertised it,
// the column stored whatever string you sent, and `importPage` stamped `acl = ['ws:'||workspace]`
// regardless — so `scope:'private'` produced a row every member of the workspace could read.
//
// It mattered more than a mislabelled column because at M4 the enforced RLS predicate becomes
// `acl && current_grants()`. The database reads the ACL and never the label, so any row written with
// a mismatched pair would have been permanently mis-scoped with the author's intent unrecoverable.
// These tests pin the property that makes that unrepresentable: the acl is DERIVED, never set
// independently.
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { aclForScope, buildContext, resolveGrants, isPageScope, PAGE_SCOPES, DEFAULT_PAGE_SCOPE } from '../src/core/context.ts';
import { adminSql, closePools } from '../src/db/client.ts';
import { importPage } from '../src/ingest/import.ts';
import { liveOrFail, hasDbEnv } from './helpers/live.ts';
import { installFakeAiFetch } from './helpers/fake-ai.ts';
import { config } from '../src/config.ts';

const P = '11111111-1111-4111-8111-111111111111';
const W = '22222222-2222-4222-8222-222222222222';
const ctx = { principal: P, workspaceId: W };

describe('aclForScope — the mapping itself (pure)', () => {
  it('private grants ONLY the author', () => {
    expect(aclForScope('private', ctx)).toEqual([`self:${P}`]);
  });

  it('workspace grants the whole tenant', () => {
    expect(aclForScope('workspace', ctx)).toEqual([`ws:${W}`]);
  });

  it('a private acl never carries a ws: tag — that is the whole point', () => {
    // The original bug in one assertion: `scope:'private'` used to yield ['ws:<workspace>'].
    const acl = aclForScope('private', ctx);
    expect(acl.some((g) => g.startsWith('ws:'))).toBe(false);
  });

  it('every declared scope maps to a non-empty acl (no scope can produce an unreadable row)', () => {
    for (const s of PAGE_SCOPES) {
      const acl = aclForScope(s, ctx);
      expect(acl.length).toBeGreaterThan(0);
      // …and every tag must be one the caller's own keyring could match.
      const keyring = resolveGrants(P, W);
      expect(acl.every((g) => keyring.includes(g))).toBe(true);
    }
  });

  it('isPageScope rejects anything outside the enum', () => {
    for (const good of PAGE_SCOPES) expect(isPageScope(good)).toBe(true);
    for (const bad of ['admin', 'PRIVATE', 'public', '', 'ws', 'self']) expect(isPageScope(bad)).toBe(false);
  });

  it('the default is workspace (D0.1) — a brain nobody else can read is not a company brain', () => {
    expect(DEFAULT_PAGE_SCOPE).toBe('workspace');
  });
});

const live = liveOrFail('scope-acl', hasDbEnv());

describe.skipIf(!live)('scope → acl, written to the database', () => {
  const RUN = crypto.randomUUID().slice(0, 8);
  const made: string[] = [];

  // embed() is mocked, same as ingest/hybrid/answer: this test is about which acl gets WRITTEN, not
  // about embedding quality. Without the mock it inherits OpenAI's uptime — it failed once on a
  // provider 500 — and spends real money asserting a pure mapping.
  const mutableConfig = config as unknown as Record<string, unknown>;
  const realKey = mutableConfig.OPENAI_API_KEY;
  const realFetch = globalThis.fetch;

  beforeAll(() => {
    mutableConfig.OPENAI_API_KEY = 'test-key';
    globalThis.fetch = installFakeAiFetch();
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    mutableConfig.OPENAI_API_KEY = realKey;
    const sql = adminSql();
    for (const id of made) await sql`delete from pages where id = ${id}`;
    await closePools({ timeout: 5 });
  }, 60_000);

  async function ingestAs(scope: 'private' | 'workspace' | undefined, principal: string, workspaceId: string) {
    const c = buildContext({ principal, workspaceId, role: 'owner', grants: resolveGrants(principal, workspaceId), remote: false });
    const r = await importPage(c, { slug: `sc-${scope ?? 'default'}-${RUN}`, title: 'T', body: 'hello world', scope });
    made.push(r.pageId);
    const sql = adminSql();
    const page = (await sql<{ scope: string; acl: string[] }[]>`select scope, acl from pages where id = ${r.pageId}`)[0]!;
    const chunk = (await sql<{ acl: string[] }[]>`select acl from content_chunks where page_id = ${r.pageId} limit 1`)[0];
    return { page, chunk };
  }

  it('a private page is stamped self:<author>, on the page AND its chunks', async () => {
    const seed = await adminSql()<{ id: string; workspace_id: string }[]>`
      select p.id, m.workspace_id from principals p
      join workspace_members m on m.principal_id = p.id limit 1`;
    const { id: principal, workspace_id } = seed[0]!;

    const { page, chunk } = await ingestAs('private', principal, workspace_id);
    expect(page.scope).toBe('private');
    expect(page.acl).toEqual([`self:${principal}`]);
    // content_chunks carries a DENORMALIZED copy (D4) — if it drifts, the vector path leaks.
    expect(chunk!.acl).toEqual([`self:${principal}`]);
  }, 60_000);

  it('a workspace page is stamped ws:<workspace>, and omitting scope means workspace', async () => {
    const seed = await adminSql()<{ id: string; workspace_id: string }[]>`
      select p.id, m.workspace_id from principals p
      join workspace_members m on m.principal_id = p.id limit 1`;
    const { id: principal, workspace_id } = seed[0]!;

    const explicit = await ingestAs('workspace', principal, workspace_id);
    expect(explicit.page.acl).toEqual([`ws:${workspace_id}`]);

    const omitted = await ingestAs(undefined, principal, workspace_id);
    expect(omitted.page.scope).toBe('workspace');
    expect(omitted.page.acl).toEqual([`ws:${workspace_id}`]);
  }, 60_000);

  it('the database refuses a scope the mapping does not understand (CHECK, not just zod)', async () => {
    const seed = await adminSql()<{ id: string; workspace_id: string }[]>`
      select p.id, m.workspace_id from principals p
      join workspace_members m on m.principal_id = p.id limit 1`;
    const { id: principal, workspace_id } = seed[0]!;

    // The zod enum stops this at the API. This asserts the OTHER half — that a writer bypassing the
    // op (a script, a future migration, psql) cannot persist a scope M4 would not know how to read.
    let code: string | undefined;
    try {
      await adminSql()`
        insert into pages (workspace_id, slug, title, owner_principal, scope, acl)
        values (${workspace_id}, ${`bad-${RUN}`}, 'x', ${principal}, 'admin', ${[`ws:${workspace_id}`]})`;
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe('23514'); // check_violation
  }, 60_000);
});
